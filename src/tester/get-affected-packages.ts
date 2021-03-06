import { getDefinitelyTyped } from "../get-definitely-typed";
import { Options, TesterOptions } from "../lib/common";
import { parseMajorVersionFromDirectoryName } from "../lib/definition-parser";
import { AllPackages, PackageBase, TypingsData } from "../lib/packages";
import { sourceBranch, typesDirectoryName } from "../lib/settings";
import { consoleLogger, Logger } from "../util/logging";
import { execAndThrowErrors, flatMap, logUncaughtErrors, mapDefined, mapIter, sort } from "../util/util";

if (!module.parent) {
    logUncaughtErrors(main(Options.defaults));
}
async function main(options: TesterOptions): Promise<void> {
    const changes = await getAffectedPackages(
        await AllPackages.read(await getDefinitelyTyped(options)),
        consoleLogger.info,
        options.definitelyTypedPath);
    console.log({ changedPackages: changes.changedPackages.map(t => t.desc), dependers: changes.dependentPackages.map(t => t.desc) });
}

export interface Affected {
    readonly changedPackages: ReadonlyArray<TypingsData>;
    readonly dependentPackages: ReadonlyArray<TypingsData>;
}

/** Gets all packages that have changed on this branch, plus all packages affected by the change. */
export default async function getAffectedPackages(allPackages: AllPackages, log: Logger, definitelyTypedPath: string): Promise<Affected> {
    const changedPackageIds = await gitChanges(log, definitelyTypedPath);
    // If a package doesn't exist, that's because it was deleted.
    const changedPackages = mapDefined(changedPackageIds, (({ name, majorVersion }) =>
        majorVersion === "latest" ? allPackages.tryGetLatestVersion(name) : allPackages.tryGetTypingsData({ name, majorVersion })));
    const dependentPackages = collectDependers(changedPackages, getReverseDependencies(allPackages));
    return { changedPackages, dependentPackages };
}

/** Every package name in the original list, plus their dependencies (incl. dependencies' dependencies). */
export function allDependencies(allPackages: AllPackages, packages: Iterable<TypingsData>): TypingsData[] {
    return sortPackages(transitiveClosure(packages, pkg => allPackages.allDependencyTypings(pkg)));
}

/** Collect all packages that depend on changed packages, and all that depend on those, etc. */
function collectDependers(changedPackages: TypingsData[], reverseDependencies: Map<TypingsData, Set<TypingsData>>): TypingsData[] {
    const dependers = transitiveClosure(changedPackages, pkg => reverseDependencies.get(pkg) || []);
    // Don't include the original changed packages, just their dependers
    for (const original of changedPackages) {
        dependers.delete(original);
    }
    return sortPackages(dependers);
}

function sortPackages(packages: Iterable<TypingsData>): TypingsData[] {
    return sort<TypingsData>(packages, PackageBase.compare); // tslint:disable-line no-unbound-method
}

function transitiveClosure<T>(initialItems: Iterable<T>, getRelatedItems: (item: T) => Iterable<T>): Set<T> {
    const all = new Set<T>();
    const workList: T[] = [];

    function add(item: T): void {
        if (!all.has(item)) {
            all.add(item);
            workList.push(item);
        }
    }

    for (const item of initialItems) {
        add(item);
    }

    while (workList.length) {
        const item = workList.pop()!;
        for (const newItem of getRelatedItems(item)) {
            add(newItem);
        }
    }

    return all;
}

/** Generate a map from a package to packages that depend on it. */
function getReverseDependencies(allPackages: AllPackages): Map<TypingsData, Set<TypingsData>> {
    const map = new Map<TypingsData, Set<TypingsData>>();

    for (const typing of allPackages.allTypings()) {
        map.set(typing, new Set());
    }

    for (const typing of allPackages.allTypings()) {
        for (const dependency of allPackages.allDependencyTypings(typing)) {
            map.get(dependency)!.add(typing);
        }
    }

    return map;
}

interface PackageVersion { name: string; majorVersion: number | "latest"; }

/** Returns all immediate subdirectories of the root directory that have changed. */
async function gitChanges(log: Logger, definitelyTypedPath: string): Promise<Iterable<PackageVersion>> {
    const changedPackages = new Map<string, Set<number | "latest">>();

    for (const fileName of await gitDiff(log, definitelyTypedPath)) {
        const dep = getDependencyFromFile(fileName);
        if (dep) {
            const versions = changedPackages.get(dep.name);
            if (!versions) {
                changedPackages.set(dep.name, new Set([dep.majorVersion]));
            } else {
                versions.add(dep.majorVersion);
            }
        }
    }

    return flatMap(changedPackages, ([name, versions]) =>
        mapIter(versions, majorVersion => ({ name, majorVersion })));
}

/*
We have to be careful about how we get the diff because travis uses a shallow clone.

Travis runs:
    git clone --depth=50 https://github.com/DefinitelyTyped/DefinitelyTyped.git DefinitelyTyped
    cd DefinitelyTyped
    git fetch origin +refs/pull/123/merge
    git checkout -qf FETCH_HEAD

If editing this code, be sure to test on both full and shallow clones.
*/
async function gitDiff(log: Logger, definitelyTypedPath: string): Promise<string[]> {
    try {
        await run(`git rev-parse --verify ${sourceBranch}`);
        // If this succeeds, we got the full clone.
    } catch (_) {
        // This is a shallow clone.
        await run(`git fetch origin ${sourceBranch}`);
        await run(`git branch ${sourceBranch} FETCH_HEAD`);
    }

    // `git diff foo...bar` gets all changes from X to `bar` where X is the common ancestor of `foo` and `bar`.
    // Source: https://git-scm.com/docs/git-diff
    let diff = (await run(`git diff ${sourceBranch} --name-only`)).trim();
    if (diff === "") {
        // We are probably already on master, so compare to the last commit.
        diff = (await run(`git diff ${sourceBranch}~1 --name-only`)).trim();
    }
    return diff.split("\n");

    async function run(cmd: string): Promise<string> {
        log(`Running: ${cmd}`);
        const stdout = await execAndThrowErrors(cmd, definitelyTypedPath);
        log(stdout);
        return stdout;
    }
}

/**
 * For "types/a/b/c", returns { name: "a", version: "latest" }.
 * For "types/a/v3/c", returns { name: "a", version: 3 }.
 * For "x", returns undefined.
 */
function getDependencyFromFile(fileName: string): PackageVersion | undefined {
    const parts = fileName.split("/");
    if (parts.length <= 2) {
        // It's not in a typings directory at all.
        return undefined;
    }

    const [typesDirName, name, subDirName] = parts; // Ignore any other parts

    if (typesDirName !== typesDirectoryName) {
        return undefined;
    }

    if (subDirName) {
        // Looks like "types/a/v3/c"
        const majorVersion = parseMajorVersionFromDirectoryName(subDirName);
        if (majorVersion !== undefined) {
            return { name,  majorVersion };
        }
    }

    return { name, majorVersion: "latest" };
}
