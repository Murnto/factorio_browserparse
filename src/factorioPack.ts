import { compareVersions } from "./utils";
import * as fs from "fs";
import { FactorioMod } from "./factorioMod";
import { FactorioLuaEngine } from "./factorioLuaEngine";
import * as ini from "ini";
import merge = require("lodash.merge");

export class FactorioPack {
    public modLoadOrder: string[] = ["core"]; // core is always first
    public mods: { [index: string]: FactorioMod } = {};

    public addMod(mod: FactorioMod) {
        this.mods[mod.info.name] = mod;
    }

    public loadData() {
        const data = new FactorioLuaEngine(this).load();

        fs.writeFileSync("data.json", JSON.stringify(data));
    }

    public async loadLocale(targetLocale?: string): Promise<{ [lang: string]: { [section: string]: { [key: string]: string } } }> {
        const locales = {};

        for (const name of this.modLoadOrder) {
            const mod = this.mods[name];

            const localeFiles = await mod.getFiles(p => p.indexOf("locale/") === 0 && p.endsWith(".cfg"), "text");
            const filenames = Object.keys(localeFiles);
            filenames.sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));

            for (const fn of filenames) {
                const locIdx = fn.indexOf("locale/") + 7;
                const language = fn.slice(locIdx, fn.indexOf("/", locIdx));

                if (targetLocale && targetLocale !== language) {
                    continue;
                }
                if (!locales[language]) {
                    locales[language] = {};
                }

                merge(locales[language], ini.parse(localeFiles[fn].content));
            }
        }

        return locales;
    }

    public async loadModArchive(zipPath: string) {
        // console.time(`Loading archive: ${zipPath}`);
        const mod = new FactorioMod();

        await mod.load(zipPath);

        this.addMod(mod);
        // console.timeEnd(`Loading archive: ${zipPath}`);
    }

    public resolveMods() {
        const remaining = Object.keys(this.mods);
        remaining.sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));

        let priorProgress = -1;

        while (remaining.length) {
            if (priorProgress === remaining.length) {
                throw new Error(`Stuck resolving remaining mods: ${remaining}`);
            }
            priorProgress = remaining.length;

            for (const name of remaining) {
                const mod = this.mods[name];

                if (this.modLoadOrder.indexOf(name) !== -1) {
                    // skip mods that are already loaded
                    remaining.splice(remaining.indexOf(name), 1);
                    continue;
                }

                let fail = false;
                for (const dep of mod.dependencies) {
                    if (this.mods[dep.name] === undefined) {
                        if (dep.optional) {
                            continue; // skip missing optional dependency
                        }

                        throw new Error(`Dependency check failed! "${name}" requires unknown mod "${dep.name}"`);
                    }

                    if (this.modLoadOrder.indexOf(dep.name) === -1) {
                        fail = true;

                        break; // dependency not loaded yet
                    }

                    if (dep.version === undefined) {
                        continue;
                    }

                    const depMod = this.mods[dep.name];
                    const versionComparison = compareVersions(dep.version, depMod.info.version);
                    switch (dep.relation) {
                        case "=":
                            if (versionComparison !== 0) {
                                throw new Error(`Dependency check failed! "${name}" requires version "${dep.version}" of "${dep.name}", but found "${depMod.info.version}" instead`);
                            }
                            break;
                        case ">=":
                            if (versionComparison < 0) {
                                throw new Error(`Dependency check failed! "${name}" requires at least version "${dep.version}" of "${dep.name}", but found "${depMod.info.version}" instead`);
                            }
                            break;
                        default:
                            throw new Error(`Unknown dependency relation "${dep.relation}"`);
                    }
                }

                if (fail) {
                    continue; // can't load this mod at this time
                }

                this.modLoadOrder.push(name);
                remaining.splice(remaining.indexOf(name), 1);
                // console.log(`Load: "${name}"`);
                break;
            }
        }
    }
}
