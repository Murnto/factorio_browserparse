import { compareVersions, dumpMemUsage } from "./utils";
import { FactorioMod } from "./factorioMod";
import { FactorioLuaEngine } from "./factorioLuaEngine";
import * as ini from "ini";
import { IconManager } from "./iconManager";
import merge = require("lodash.merge");
import { resolveLocale } from "./factorioLocale";
import * as assert from "assert";
import { ModDependencyError } from "./modDependencyError";

const itemTypes = [
    "fluid",
    "item",
    "gun",
    "blueprint",
    "deconstruction-item",
    "ammo",
    "capsule",
    "rail-planner",
    "module",
    "armor",
    "tool",
    "mining-tool",
    "repair-tool",
    "item-with-entity-data",
    "item-with-label",
    "item-with-tags",
    "item-with-inventory",
];

export class FactorioPack {
    public modLoadOrder: string[] = ["core"]; // core is always first
    public mods: { [index: string]: FactorioMod } = {};
    private iconManager = new IconManager(this);
    private packName: string;

    constructor(packName: string) {
        this.packName = packName;
    }

    public addMod(mod: FactorioMod) {
        this.mods[mod.info.name] = mod;
    }

    public async dumpPack(): Promise<any> {
        console.time("pack.loadLocale()");
        const locale = await this.loadLocale("en");
        console.timeEnd("pack.loadLocale()");
        dumpMemUsage("After locale");

        console.time("pack.loadData()");
        const data = await this.loadData();
        console.timeEnd("pack.loadData()");
        dumpMemUsage("After data");

        // fs.writeFileSync("data.json", JSON.stringify(data));

        this.augmentData(data, locale);
        return this.dumpJson(data);
    }

    public async loadModArchive(zipPath: string) {
        // console.time(`Loading archive: ${zipPath}`);
        const mod = new FactorioMod();

        await mod.load(zipPath);

        this.addMod(mod);
        // console.timeEnd(`Loading archive: ${zipPath}`);
    }

    public removeMod(name: string) {
        delete this.mods[name];
    }

    public resolveMods() {
        this.modLoadOrder = ["core"];

        const remaining = Object.keys(this.mods);
        remaining.sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));

        let priorProgress = -1;

        while (remaining.length) {
            if (priorProgress === remaining.length) {
                throw new ModDependencyError(`Stuck resolving remaining mods: ${remaining}`);
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

                        throw new ModDependencyError(`Dependency check failed! "${name}" requires unknown mod "${dep.name}"`, mod);
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
                                throw new ModDependencyError(`Dependency check failed! "${name}" requires version "${dep.version}" of "${dep.name}", but found "${depMod.info.version}" instead`, mod);
                            }
                            break;
                        case ">=":
                            if (versionComparison < 0) {
                                throw new ModDependencyError(
                                    `Dependency check failed! "${name}" requires at least version "${dep.version}" of "${dep.name}", but found "${depMod.info.version}" instead`,
                                    mod,
                                );
                            }
                            break;
                        default:
                            throw new ModDependencyError(`Unknown dependency relation "${dep.relation}"`, mod);
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

    private applyDifficulty(obj: any, difficulty: string) {
        if (obj[difficulty] === undefined) {
            return;
        }

        merge(obj, obj[difficulty]);

        delete obj[difficulty];

        // also delete other known difficulties
        delete obj.normal;
        delete obj.expensive;
    }

    private augmentData(data: any, locale: { [lang: string]: { [section: string]: { [key: string]: string } } }, lang: string = "en") {
        const ctx = {
            lang,
            locale,
            defaultSections: ["item-name", "fluid-name", "technology-name", "recipe-name", "entity-name"],
        };

        for (const item of Object.values(data.item)) {
            this.applyDifficulty(item, "normal");
        }

        for (const rName of Object.keys(data.recipe)) {
            const recipe = data.recipe[rName];

            this.applyDifficulty(recipe, "normal");
            this.fixRecipe(data, recipe);
        }

        for (const technology of Object.values(data.technology as { [i: string]: any })) {
            this.applyDifficulty(technology, "normal");

            if (technology.unit) {
                this.fixItemAmounts(data, technology.unit.ingredients);
            }
        }

        for (const type of Object.keys(data)) {
            const newCtx = {
                ...ctx,
                defaultSections: [`${type}-name`, ...ctx.defaultSections],
            };

            for (const obj of Object.values(data[type])) {
                resolveLocale(obj, newCtx);
            }
        }
    }

    private async dumpJson(data: any): Promise<any> {
        // TODO
        // const fs = require("fs");
        // fs.mkdirSync(`pack`, { recursive: true });
        // fs.mkdirSync(`icon`, { recursive: true });
        // const minimized = true;

        const techs = {};
        const recipes = {};
        const processedData = {
            recipe: recipes,
            technology: techs,
        };

        const unlockableRecipes = {};
        for (const tech of Object.values(data.technology as { [i: string]: any })) {
            const canBeUnlocked = tech.enabled === undefined ? true : !!tech.enabled;

            // TODO recursively check prereqs?

            if (!canBeUnlocked) {
                continue;
            }

            await this.processPrototype(tech);

            techs[tech.name] = tech;

            if (tech.unit !== undefined && tech.unit.ingredients !== undefined) {
                for (const ingd of tech.unit.ingredients) {
                    this.fixItemAmounts(data, ingd);
                }
            }

            if (tech.effects === undefined) {
                continue;
            }

            for (const eff of tech.effects) {
                if (eff.type === "unlock-recipe") {
                    unlockableRecipes[eff.recipe] = true;
                }
            }
        }

        // for (const type of itemTypes) {
        //     processedData[type] = {};
        //
        //     if (data[type] === undefined) {
        //         console.log(`"${type}" not found in data?`);
        //         continue;
        //     }
        //
        //     for (const item of Object.values(Object.values(data[type] as { [i: string]: any }))) {
        //         await this.processPrototype(item);
        //
        //         processedData[type][item.name] = item;
        //     }
        // }

        // noinspection TypeScriptUnresolvedVariable
        await Promise.all(
            Object.values(data.recipe)
                .filter((recipe: any) => unlockableRecipes[recipe.name] || (recipe.enabled !== false && recipe.enabled !== "false"))
                .map(async (recipe: any) => {
                    await this.processPrototype(recipe);

                    recipes[recipe.name] = recipe;
                }),
        );

        for (const type of Object.keys(data)) {
            if (processedData[type] !== undefined) {
                continue;
            }

            processedData[type] = {};

            for (const item of Object.values(Object.values(data[type] as { [i: string]: any }))) {
                await this.processPrototype(item);

                processedData[type][item.name] = item;
            }
        }

        // FIXME
        // const fs = require("fs");
        // fs.writeFileSync(`pack/${this.packName}.json`, JSON.stringify(processedData));

        return processedData;
    }

    private fixItemAmounts(data: any, items: any) {
        if (items === undefined) {
            return;
        }

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            if (Array.isArray(item)) {
                items[i] = {
                    amount: item[1],
                    name: item[0],
                    type: "item",
                };
            }

            const resolved = this.resolvePrototype(data, items[i].type, items[i].name);
            if (resolved !== undefined) {
                items[i].type = resolved.type;
            }
        }
    }

    private fixRecipe(data: any, recipe: any) {
        this.fixItemAmounts(data, recipe.ingredients);
        this.fixItemAmounts(data, recipe.results);

        if (recipe.result === undefined) {
            return;
        }
        if (recipe.results !== undefined) {
            throw new Error("Recipe had result and results?");
        }

        if (recipe.result_count !== undefined) {
            recipe.results = [
                {
                    amount: recipe.result_count,
                    name: recipe.result,
                    type: (this.resolvePrototype(data, "item", recipe.result) || {}).type,
                },
            ];

            delete recipe.result_count;
        } else {
            recipe.results = [
                {
                    amount: 1,
                    name: recipe.result,
                    type: (this.resolvePrototype(data, "item", recipe.result) || {}).type,
                },
            ];
        }

        delete recipe.result;
    }

    private loadData(): any {
        return new FactorioLuaEngine(this).load();
    }

    private async loadLocale(targetLocale?: string): Promise<{ [lang: string]: { [section: string]: { [key: string]: string } } }> {
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

    private async processPrototype(obj: any) {
        if (obj.icon !== undefined) {
            obj.icon = await this.iconManager.resolveIcon(obj.icon);
        }
        if (obj.icons !== undefined) {
            assert(Array.isArray(obj.icons));
            for (const def of obj.icons) {
                def.icon = await this.iconManager.resolveIcon(def.icon);
            }
        }
    }

    private resolvePrototype(data: any, type: string, name: string): any {
        let item = data[type] && data[type][name];

        if (item !== undefined) {
            return item;
        }

        for (const otype of itemTypes) {
            item = data[otype][name];

            if (item !== undefined) {
                return item;
            }
        }

        return;
    }
}
