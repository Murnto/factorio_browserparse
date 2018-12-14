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

function internalResolveLocaleString(section: string | null, key: string, ctx: LocaleContext): LocalisationResult {
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

export function resolveLocale(obj: any, ctx: LocaleContext) {
    let loc: LocalisationResult;

    if (obj.localised_name !== undefined) {
        loc = resolveLocaleFmt(obj, ctx);

        delete obj.localised_name;
    } else {
        loc = resolveLocaleString(obj.name, ctx);
    }

    obj.title = loc.data;

    if (!loc.success) {
        console.log("Didn't find locale for", obj);
    }
}

function resolveLocaleFmt(obj: any, ctx: LocaleContext): LocalisationResult {
    assert(Array.isArray(obj.localised_name));

    const locFmt = resolveLocaleString(obj.localised_name[0], ctx);

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
        const locParam = resolveLocaleString(locKeys[i], ctx);

        locFmt.data = locFmt.data.split(`__${i + 1}__`).join(locParam.data);
    }

    return locFmt;
}

function resolveLocaleString(locKey: string, ctx: LocaleContext): LocalisationResult {
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

    const origLoc = internalResolveLocaleString(section, key!, ctx);
    if (origLoc.success) {
        return origLoc;
    }

    if (tierKey !== undefined) {
        const origLocTier = internalResolveLocaleString(section, tierKey, ctx);

        if (origLocTier.success) {
            return {
                ...origLocTier,
                data: origLocTier.data + " " + tierValue,
            };
        }
    }

    if (ctx.defaultSections) {
        for (const fallback of ctx.defaultSections) {
            const loc = internalResolveLocaleString(fallback, key!, ctx);

            if (loc.success) {
                return loc;
            }

            if (tierKey === undefined) {
                continue;
            }

            const locTier = internalResolveLocaleString(fallback, tierKey!, ctx);

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
