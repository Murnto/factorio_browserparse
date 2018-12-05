import { compareVersions, dumpMemUsage } from "./utils";
import { lua_value_to_js } from "./lua_utils";
import * as fs from "fs";
import { FactorioMod } from "./FactorioMod";
import { FactorioModLua } from "./FactorioModLua";
// @ts-ignore
import { lua } from "fengari";

export class FactorioPack {
    public mods: { [index: string]: FactorioMod } = {};
    public modLoadOrder: string[] = ["core"]; // core is always first

    public async loadModArchive(zipPath: string) {
        // console.time(`Loading archive: ${zipPath}`);
        const mod = new FactorioMod();

        await mod.load(zipPath);

        this.addMod(mod);
        // console.timeEnd(`Loading archive: ${zipPath}`);
    }

    public addMod(mod: FactorioMod) {
        this.mods[mod.info.name] = mod;
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
                        } else {
                            throw new Error(`Dependency check failed! "${name}" requires unknown mod "${dep.name}"`);
                        }
                    }

                    if (this.modLoadOrder.indexOf(dep.name) === -1) {
                        fail = true;

                        break; // dependency not loaded yet
                    }

                    if (dep.version !== undefined) {
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

    public loadMods() {
        // TODO load locale

        const mods = this.modLoadOrder.map(k => this.mods[k]);

        const factorioLua = new FactorioModLua();
        factorioLua.init();
        dumpMemUsage("After lua init");
        factorioLua.load_mods(this, mods);

        dumpMemUsage("After mod load");

        lua.lua_getglobal(factorioLua.L, "data");
        const jsonData = JSON.stringify(lua_value_to_js(factorioLua.L, -1));

        fs.writeFileSync("data.json", jsonData);

        factorioLua.close();

        dumpMemUsage("Before gc");
        global.gc();
        dumpMemUsage("After gc");
    }
}
