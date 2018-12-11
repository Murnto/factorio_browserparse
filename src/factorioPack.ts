import { compareVersions, dumpMemUsage } from "./utils";
import * as fs from "fs";
import { FactorioMod } from "./factorioMod";
import { FactorioLuaEngine } from "./factorioLuaEngine";
import * as ini from "ini";
import merge = require("lodash.merge");
import assert = require("assert");

interface LocaleContext {
    defaultSections?: string[];
    lang: string;
    locale: { [lang: string]: { [section: string]: { [key: string]: string } } };
}

interface LocalisationResult {
    data: string;
    partial?: boolean;
    success: boolean;
}

export class FactorioPack {
    public modLoadOrder: string[] = ["core"]; // core is always first
    public mods: { [index: string]: FactorioMod } = {};

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
            this.resolveLocale(item, ctx);
        }

        for (const rName of Object.keys(data.recipe)) {
            const recipe = data.recipe[rName];

            this.applyDifficulty(recipe, "normal");
            this.fixRecipe(recipe);
            if (recipe.name === "angels-nitinol-smelting-1") {
                console.log("a");
            }
            this.resolveLocale(recipe, {
                ...ctx,
                defaultSections: ["recipe-name", ...ctx.defaultSections],
            });
        }

        for (const technology of Object.values(data.technology)) {
            this.applyDifficulty(technology, "normal");
            this.resolveLocale(technology, {
                ...ctx,
                defaultSections: ["technology-name", ...ctx.defaultSections],
            });
        }
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

    private internalResolveLocaleString(section: string | null, key: string, ctx: LocaleContext): LocalisationResult {
        if (ctx.locale[ctx.lang] === undefined) {
            return { data: `{${section}.${key}}`, success: false };
        }
        if (section === null) {
            if (ctx.locale[ctx.lang][key] === undefined) {
                return { data: `{${key}}`, success: false };
            }

            return { data: (ctx.locale[ctx.lang][key] as any) as string, success: true };
        }
        if (ctx.locale[ctx.lang][section] === undefined) {
            return { data: `{${section}.${key}}`, success: false };
        }
        if (ctx.locale[ctx.lang][section][key] === undefined) {
            return { data: `{${section}.${key}}`, success: false };
        }

        return { data: ctx.locale[ctx.lang][section][key], success: true };
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

    private resolveLocale(obj: any, ctx: LocaleContext) {
        let loc: LocalisationResult;

        if (obj.localised_name !== undefined) {
            loc = this.resolveLocaleFmt(obj, ctx);

            delete obj.localised_name;
        } else {
            loc = this.resolveLocaleString(obj.name, ctx);
        }

        obj.title = loc.data;

        if (!loc.success) {
            console.log("Didn't find locale for", obj);
        }
    }

    private resolveLocaleFmt(obj: any, ctx: LocaleContext): LocalisationResult {
        assert(Array.isArray(obj.localised_name));

        const locFmt = this.resolveLocaleString(obj.localised_name[0], ctx);

        if (!locFmt.success) {
            return {
                data: `${obj.localised_name[0]}-${obj.localised_name[1].join("-")}`,
                success: false,
            };
        }

        if (obj.localised_name[1] === undefined) {
            return locFmt;
        }

        let locKeys: string[];

        if (typeof obj.localised_name[1] === "string") {
            locKeys = [obj.localised_name[1]];
        } else if (Array.isArray(obj.localised_name[1])) {
            locKeys = obj.localised_name[1];
        } else {
            console.log(":(");
            throw Error("What is obj.localised_name[1]?");
        }

        for (let i = 0; i < locKeys.length; i++) {
            const locParam = this.resolveLocaleString(locKeys[i], ctx);

            locFmt.data = locFmt.data.split(`__${i + 1}__`).join(locParam.data);
        }

        return locFmt;
    }

    private resolveLocaleString(locKey: string, ctx: LocaleContext): LocalisationResult {
        const spl = locKey.indexOf(".") !== -1 ? locKey.split(".", 2) : [null, locKey];
        const [section, key] = spl;

        const tierIndex = key!.lastIndexOf("-");
        let tierKey: string | undefined;
        let tierValue: number | undefined;

        if (tierIndex !== -1) {
            tierValue = parseInt(key!.slice(tierIndex + 1), 10);

            if (!isNaN(tierValue)) {
                tierKey = key!.slice(0, tierIndex);
            }
        }

        const origLoc = this.internalResolveLocaleString(section, key!, ctx);
        if (origLoc.success) {
            return origLoc;
        }

        if (tierKey !== undefined) {
            const origLocTier = this.internalResolveLocaleString(section, tierKey, ctx);

            if (origLocTier.success) {
                return {
                    ...origLocTier,
                    data: origLocTier.data + " " + tierValue,
                };
            }
        }

        if (ctx.defaultSections) {
            for (const fallback of ctx.defaultSections) {
                const loc = this.internalResolveLocaleString(fallback, key!, ctx);

                if (loc.success) {
                    return loc;
                }

                if (tierKey === undefined) {
                    continue;
                }

                const locTier = this.internalResolveLocaleString(fallback, tierKey!, ctx);

                if (!locTier.success) {
                    continue;
                }

                return {
                    ...locTier,
                    data: locTier.data + " " + tierValue,
                };
            }
        }

        return origLoc;
    }
}
