import { compareVersions, dumpMemUsage } from "./utils";
import * as fs from "fs";
import { FactorioMod } from "./factorioMod";
import { FactorioLuaEngine } from "./factorioLuaEngine";
import * as ini from "ini";
import { IconManager } from "./iconManager";
import merge = require("lodash.merge");
import { resolveLocale } from "./factorioLocale";
import * as assert from "assert";

export class FactorioPack {
    public modLoadOrder: string[] = ["core"]; // core is always first
    public mods: { [index: string]: FactorioMod } = {};
    private iconManager = new IconManager(this);

    public async dumpPack() {
        console.time("pack.loadLocale()");
        const locale = await this.loadLocale("en");
        console.timeEnd("pack.loadLocale()");
        dumpMemUsage("After locale");

        console.time("pack.loadData()");
        const data = await this.loadData();
        console.timeEnd("pack.loadData()");
        dumpMemUsage("After data");

        this.augmentData(data, locale);
        this.dumpJson(data);

        fs.writeFileSync("data.json", JSON.stringify(data));
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

    private addMod(mod: FactorioMod) {
        this.mods[mod.info.name] = mod;
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
            resolveLocale(item, ctx);
        }

        for (const rName of Object.keys(data.recipe)) {
            const recipe = data.recipe[rName];

            this.applyDifficulty(recipe, "normal");
            this.fixRecipe(recipe);
            resolveLocale(recipe, {
                ...ctx,
                defaultSections: ["recipe-name", ...ctx.defaultSections],
            });
        }

        for (const technology of Object.values(data.technology)) {
            this.applyDifficulty(technology, "normal");
            resolveLocale(technology, {
                ...ctx,
                defaultSections: ["technology-name", ...ctx.defaultSections],
            });
        }
    }

    private async dumpJson(data: any) {
        fs.mkdirSync(`icon`, { recursive: true });
        // const minimized = true;

        const techs = {};
        const unlockableRecipes = {};
        for (const tech of Object.values(data.technology as { [i: string]: any })) {
            const canBeUnlocked = tech.enabled === undefined ? true : !!tech.enabled;

            // TODO recursively check prereqs?

            if (!canBeUnlocked) {
                continue;
            }

            this.processPrototype(tech);

            techs[tech.name] = tech;

            if (tech.effects === undefined) {
                continue;
            }

            for (const eff of tech.effects) {
                if (eff.type === "unlock-recipe") {
                    unlockableRecipes[eff.recipe] = true;
                }
            }
        }

        for (const item of Object.values(data.item)) {
            this.processPrototype(item);

            // TODO
        }

        Object.values(data.recipe)
            .filter((recipe: any) => unlockableRecipes[recipe.name])
            .forEach((recipe: any) => {
                this.processPrototype(recipe);
            });
    }

    private fixItemAmounts(items: any) {
        if (items === undefined) {
            return;
        }

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            if (!Array.isArray(item)) {
                continue;
            }

            items[i] = {
                amount: item[1],
                name: item[0],
                type: "item",
            };
        }
    }

    private fixRecipe(recipe: any) {
        this.fixItemAmounts(recipe.ingredients);
        this.fixItemAmounts(recipe.results);

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
                    type: "item",
                },
            ];

            delete recipe.result_count;
        } else {
            recipe.results = [
                {
                    amount: 1,
                    name: recipe.result,
                    type: "item",
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

    private processPrototype(obj: any) {
        if (obj.icon !== undefined) {
            obj.icon = this.iconManager.resolveIcon(obj.icon);
        } else if (obj.icons !== undefined) {
            assert(Array.isArray(obj.icons));

            for (const def of obj.icons) {
                def.icon = this.iconManager.resolveIcon(def.icon);
            }
        }
    }
}
