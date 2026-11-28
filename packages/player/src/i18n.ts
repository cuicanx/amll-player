import resources from "virtual:i18next-loader";
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";

// Guard for runtimes without a complete Intl implementation (some WebView
// builds). Every plural in our catalogue uses a single `other` branch, so a
// minimal PluralRules that always selects "other" is enough to keep the
// formatter working there.
if (typeof Intl.PluralRules === "undefined") {
	class MinimalPluralRules {
		select(): string {
			return "other";
		}
		resolvedOptions() {
			return { locale: "en", type: "cardinal" as const, pluralCategories: ["other"] };
		}
	}
	(Intl as unknown as { PluralRules: unknown }).PluralRules = MinimalPluralRules;
}

// zh-Hans-LIT and zh-CN-cat are not valid BCP-47 tags ("LIT" is not a region
// code, "cat" is too short for a variant). Intl.Locale throws RangeError on
// them, so i18next-icu fails to parse and returns the message verbatim - that
// is why literal "{count}" / "{count, plural, other {#}}" / "{channel}" showed
// up in those two languages. Map them to a valid locale for ICU formatting
// only; the actual translations still come from their own resource bundles.
const icuLocale: Record<string, string> = {
	"zh-CN-cat": "zh-CN",
	"zh-Hans-LIT": "zh-CN",
};

type ResourcesType = typeof resources;

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: "translation";
		resources: ResourcesType["zh-CN"];
	}
}

i18n
	.use(initReactI18next)
	.use(ICU)
	.use(LanguageDetector)
	.init({
		resources,
		debug: import.meta.env.DEV,
		fallbackLng: "en-US",
		defaultNS: "translation",
		interpolation: {
			escapeValue: false,
		},
		i18nFormat: {
			parseLngForICU: (lng: string) =>
				icuLocale[lng] ?? icuLocale[lng.toLowerCase()] ?? lng,
		},
		detection: {
			order: ["localStorage", "navigator"],
			lookupLocalStorage: "amll-player.language",
			caches: ["localStorage"],
		},
	});

export default i18n;
