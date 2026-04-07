use clap::ValueEnum;
use serde::Serialize;
use std::fmt;

#[derive(ValueEnum, Clone, Debug, Serialize, Hash, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
#[repr(usize)]
pub enum Language {
    #[clap(name = "english")]
    English,
    #[clap(name = "chinese")]
    Chinese,
    #[clap(name = "german")]
    German,
    #[clap(name = "spanish")]
    Spanish,
    #[clap(name = "russian")]
    Russian,
    #[clap(name = "korean")]
    Korean,
    #[clap(name = "french")]
    French,
    #[clap(name = "japanese")]
    Japanese,
    #[clap(name = "portuguese")]
    Portuguese,
    #[clap(name = "turkish")]
    Turkish,
    #[clap(name = "polish")]
    Polish,
    #[clap(name = "catalan")]
    Catalan,
    #[clap(name = "dutch")]
    Dutch,
    #[clap(name = "arabic")]
    Arabic,
    #[clap(name = "swedish")]
    Swedish,
    #[clap(name = "italian")]
    Italian,
    #[clap(name = "indonesian")]
    Indonesian,
    #[clap(name = "hindi")]
    Hindi,
    #[clap(name = "vietnamese")]
    Vietnamese,
    #[clap(name = "finnish")]
    Finnish,
    #[clap(name = "hebrew")]
    Hebrew,
    #[clap(name = "ukrainian")]
    Ukrainian,
    #[clap(name = "greek")]
    Greek,
    #[clap(name = "malay")]
    Malay,
    #[clap(name = "czech")]
    Czech,
    #[clap(name = "romanian")]
    Romanian,
    #[clap(name = "danish")]
    Danish,
    #[clap(name = "hungarian")]
    Hungarian,
    #[clap(name = "norwegian")]
    Norwegian,
    #[clap(name = "thai")]
    Thai,
    #[clap(name = "urdu")]
    Urdu,
    #[clap(name = "croatian")]
    Croatian,
    #[clap(name = "bulgarian")]
    Bulgarian,
    #[clap(name = "lithuanian")]
    Lithuanian,
    #[clap(name = "latin")]
    Latin,
    #[clap(name = "malayalam")]
    Malayalam,
    #[clap(name = "welsh")]
    Welsh,
    #[clap(name = "slovak")]
    Slovak,
    #[clap(name = "persian")]
    Persian,
    #[clap(name = "latvian")]
    Latvian,
    #[clap(name = "bengali")]
    Bengali,
    #[clap(name = "serbian")]
    Serbian,
    #[clap(name = "azerbaijani")]
    Azerbaijani,
    #[clap(name = "slovenian")]
    Slovenian,
    #[clap(name = "estonian")]
    Estonian,
    #[clap(name = "macedonian")]
    Macedonian,
    #[clap(name = "nepali")]
    Nepali,
    #[clap(name = "mongolian")]
    Mongolian,
    #[clap(name = "bosnian")]
    Bosnian,
    #[clap(name = "kazakh")]
    Kazakh,
    #[clap(name = "albanian")]
    Albanian,
    #[clap(name = "swahili")]
    Swahili,
    #[clap(name = "galician")]
    Galician,
    #[clap(name = "marathi")]
    Marathi,
    #[clap(name = "punjabi")]
    Punjabi,
    #[clap(name = "sinhala")]
    Sinhala,
    #[clap(name = "khmer")]
    Khmer,
    #[clap(name = "afrikaans")]
    Afrikaans,
    #[clap(name = "belarusian")]
    Belarusian,
    #[clap(name = "gujarati")]
    Gujarati,
    #[clap(name = "amharic")]
    Amharic,
    #[clap(name = "yiddish")]
    Yiddish,
    #[clap(name = "lao")]
    Lao,
    #[clap(name = "uzbek")]
    Uzbek,
    #[clap(name = "faroese")]
    Faroese,
    #[clap(name = "pashto")]
    Pashto,
    #[clap(name = "maltese")]
    Maltese,
    #[clap(name = "sanskrit")]
    Sanskrit,
    #[clap(name = "luxembourgish")]
    Luxembourgish,
    #[clap(name = "myanmar")]
    Myanmar,
    #[clap(name = "tibetan")]
    Tibetan,
    #[clap(name = "tagalog")]
    Tagalog,
    #[clap(name = "assamese")]
    Assamese,
    #[clap(name = "tatar")]
    Tatar,
    #[clap(name = "hausa")]
    Hausa,
    #[clap(name = "javanese")]
    Javanese,
}

impl Language {
    pub fn as_lang_code(&self) -> &'static str {
        match self {
            Language::English => "en",
            Language::Chinese => "zh",
            Language::German => "de",
            Language::Spanish => "es",
            Language::Russian => "ru",
            Language::Korean => "ko",
            Language::French => "fr",
            Language::Japanese => "ja",
            Language::Portuguese => "pt",
            Language::Turkish => "tr",
            Language::Polish => "pl",
            Language::Catalan => "ca",
            Language::Dutch => "nl",
            Language::Arabic => "ar",
            Language::Swedish => "sv",
            Language::Italian => "it",
            Language::Indonesian => "id",
            Language::Hindi => "hi",
            Language::Vietnamese => "vi",
            Language::Finnish => "fi",
            Language::Hebrew => "he",
            Language::Ukrainian => "uk",
            Language::Greek => "el",
            Language::Malay => "ms",
            Language::Czech => "cs",
            Language::Romanian => "ro",
            Language::Danish => "da",
            Language::Hungarian => "hu",
            Language::Norwegian => "no",
            Language::Thai => "th",
            Language::Urdu => "ur",
            Language::Croatian => "hr",
            Language::Bulgarian => "bg",
            Language::Lithuanian => "lt",
            Language::Latin => "la",
            Language::Malayalam => "ml",
            Language::Welsh => "cy",
            Language::Slovak => "sk",
            Language::Persian => "fa",
            Language::Latvian => "lv",
            Language::Bengali => "bn",
            Language::Serbian => "sr",
            Language::Azerbaijani => "az",
            Language::Slovenian => "sl",
            Language::Estonian => "et",
            Language::Macedonian => "mk",
            Language::Nepali => "ne",
            Language::Mongolian => "mn",
            Language::Bosnian => "bs",
            Language::Kazakh => "kk",
            Language::Albanian => "sq",
            Language::Swahili => "sw",
            Language::Galician => "gl",
            Language::Marathi => "mr",
            Language::Punjabi => "pa",
            Language::Sinhala => "si",
            Language::Khmer => "km",
            Language::Afrikaans => "af",
            Language::Belarusian => "be",
            Language::Gujarati => "gu",
            Language::Amharic => "am",
            Language::Yiddish => "yi",
            Language::Lao => "lo",
            Language::Uzbek => "uz",
            Language::Faroese => "fo",
            Language::Pashto => "ps",
            Language::Maltese => "mt",
            Language::Sanskrit => "sa",
            Language::Luxembourgish => "lb",
            Language::Myanmar => "my",
            Language::Tibetan => "bo",
            Language::Tagalog => "tl",
            Language::Assamese => "as",
            Language::Tatar => "tt",
            Language::Hausa => "ha",
            Language::Javanese => "jw",
        }
    }
}

impl std::str::FromStr for Language {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "english" | "en" => Ok(Self::English),
            "chinese" | "zh" => Ok(Self::Chinese),
            "german" | "de" => Ok(Self::German),
            "spanish" | "es" => Ok(Self::Spanish),
            "russian" | "ru" => Ok(Self::Russian),
            "korean" | "ko" => Ok(Self::Korean),
            "french" | "fr" => Ok(Self::French),
            "japanese" | "ja" => Ok(Self::Japanese),
            "portuguese" | "pt" => Ok(Self::Portuguese),
            "turkish" | "tr" => Ok(Self::Turkish),
            "polish" | "pl" => Ok(Self::Polish),
            "catalan" | "ca" => Ok(Self::Catalan),
            "dutch" | "nl" => Ok(Self::Dutch),
            "arabic" | "ar" => Ok(Self::Arabic),
            "swedish" | "sv" => Ok(Self::Swedish),
            "italian" | "it" => Ok(Self::Italian),
            "indonesian" | "id" => Ok(Self::Indonesian),
            "hindi" | "hi" => Ok(Self::Hindi),
            "vietnamese" | "vi" => Ok(Self::Vietnamese),
            "finnish" | "fi" => Ok(Self::Finnish),
            "hebrew" | "he" => Ok(Self::Hebrew),
            "ukrainian" | "uk" => Ok(Self::Ukrainian),
            "greek" | "el" => Ok(Self::Greek),
            "malay" | "ms" => Ok(Self::Malay),
            "czech" | "cs" => Ok(Self::Czech),
            "romanian" | "ro" => Ok(Self::Romanian),
            "danish" | "da" => Ok(Self::Danish),
            "hungarian" | "hu" => Ok(Self::Hungarian),
            "norwegian" | "no" => Ok(Self::Norwegian),
            "thai" | "th" => Ok(Self::Thai),
            "urdu" | "ur" => Ok(Self::Urdu),
            "croatian" | "hr" => Ok(Self::Croatian),
            "bulgarian" | "bg" => Ok(Self::Bulgarian),
            "lithuanian" | "lt" => Ok(Self::Lithuanian),
            "latin" | "la" => Ok(Self::Latin),
            "malayalam" | "ml" => Ok(Self::Malayalam),
            "welsh" | "cy" => Ok(Self::Welsh),
            "slovak" | "sk" => Ok(Self::Slovak),
            "persian" | "fa" => Ok(Self::Persian),
            "latvian" | "lv" => Ok(Self::Latvian),
            "bengali" | "bn" => Ok(Self::Bengali),
            "serbian" | "sr" => Ok(Self::Serbian),
            "azerbaijani" | "az" => Ok(Self::Azerbaijani),
            "slovenian" | "sl" => Ok(Self::Slovenian),
            "estonian" | "et" => Ok(Self::Estonian),
            "macedonian" | "mk" => Ok(Self::Macedonian),
            "nepali" | "ne" => Ok(Self::Nepali),
            "mongolian" | "mn" => Ok(Self::Mongolian),
            "bosnian" | "bs" => Ok(Self::Bosnian),
            "kazakh" | "kk" => Ok(Self::Kazakh),
            "albanian" | "sq" => Ok(Self::Albanian),
            "swahili" | "sw" => Ok(Self::Swahili),
            "galician" | "gl" => Ok(Self::Galician),
            "marathi" | "mr" => Ok(Self::Marathi),
            "punjabi" | "pa" => Ok(Self::Punjabi),
            "sinhala" | "si" => Ok(Self::Sinhala),
            "khmer" | "km" => Ok(Self::Khmer),
            "afrikaans" | "af" => Ok(Self::Afrikaans),
            "belarusian" | "be" => Ok(Self::Belarusian),
            "gujarati" | "gu" => Ok(Self::Gujarati),
            "amharic" | "am" => Ok(Self::Amharic),
            "yiddish" | "yi" => Ok(Self::Yiddish),
            "lao" | "lo" => Ok(Self::Lao),
            "uzbek" | "uz" => Ok(Self::Uzbek),
            "faroese" | "fo" => Ok(Self::Faroese),
            "pashto" | "ps" => Ok(Self::Pashto),
            "maltese" | "mt" => Ok(Self::Maltese),
            "sanskrit" | "sa" => Ok(Self::Sanskrit),
            "luxembourgish" | "lb" => Ok(Self::Luxembourgish),
            "myanmar" | "my" => Ok(Self::Myanmar),
            "tibetan" | "bo" => Ok(Self::Tibetan),
            "tagalog" | "tl" => Ok(Self::Tagalog),
            "assamese" | "as" => Ok(Self::Assamese),
            "tatar" | "tt" => Ok(Self::Tatar),
            "hausa" | "ha" => Ok(Self::Hausa),
            "javanese" | "jw" => Ok(Self::Javanese),
            _ => Err(format!("unknown language: {s}")),
        }
    }
}

impl fmt::Display for Language {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let possible_value = self.to_possible_value().unwrap();
        let action_name = possible_value.get_name();
        write!(f, "{}", action_name)
    }
}

impl PartialEq<&str> for Language {
    fn eq(&self, other: &&str) -> bool {
        self.to_string().as_str() == *other
    }
}

pub const TESSERACT_LANGUAGES: [(&str, &str); 76] = [
    ("eng", "english"),
    ("chi_sim", "chinese"),
    ("deu", "german"),
    ("spa", "spanish"),
    ("rus", "russian"),
    ("kor", "korean"),
    ("fra", "french"),
    ("jpn", "japanese"),
    ("por", "portuguese"),
    ("tur", "turkish"),
    ("pol", "polish"),
    ("cat", "catalan"),
    ("nld", "dutch"),
    ("ara", "arabic"),
    ("swe", "swedish"),
    ("ita", "italian"),
    ("ind", "indonesian"),
    ("hin", "hindi"),
    ("fin", "finnish"),
    ("vie", "vietnamese"),
    ("heb", "hebrew"),
    ("ukr", "ukrainian"),
    ("ell", "greek"),
    ("msa", "malay"),
    ("ces", "czech"),
    ("ron", "romanian"),
    ("dan", "danish"),
    ("hun", "hungarian"),
    ("nor", "norwegian"),
    ("tha", "thai"),
    ("urd", "urdu"),
    ("hrv", "croatian"),
    ("bul", "bulgarian"),
    ("lit", "lithuanian"),
    ("lat", "latin"),
    ("mal", "malayalam"),
    ("cym", "welsh"),
    ("slk", "slovak"),
    ("fas", "persian"),
    ("lav", "latvian"),
    ("ben", "bengali"),
    ("srp", "serbian"),
    ("aze", "azerbaijani"),
    ("slv", "slovenian"),
    ("est", "estonian"),
    ("mkd", "macedonian"),
    ("nep", "nepali"),
    ("mon", "mongolian"),
    ("bos", "bosnian"),
    ("kaz", "kazakh"),
    ("sqi", "albanian"),
    ("swa", "swahili"),
    ("glg", "galician"),
    ("mar", "marathi"),
    ("pan", "punjabi"),
    ("sin", "sinhala"),
    ("khm", "khmer"),
    ("afr", "afrikaans"),
    ("bel", "belarusian"),
    ("guj", "gujarati"),
    ("amh", "amharic"),
    ("yid", "yiddish"),
    ("lao", "lao"),
    ("uzb", "uzbek"),
    ("fo", "faroese"),
    ("pus", "pashto"),
    ("mlt", "maltese"),
    ("san", "sanskrit"),
    ("lb", "luxembourgish"),
    ("mya", "myanmar"),
    ("bod", "tibetan"),
    ("tgl", "tagalog"),
    ("asm", "assamese"),
    ("tat", "tatar"),
    ("hau", "hausa"),
    ("jav", "javanese"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_from_str_by_name() {
        assert_eq!("english".parse::<Language>().unwrap(), Language::English);
        assert_eq!("french".parse::<Language>().unwrap(), Language::French);
        assert_eq!("japanese".parse::<Language>().unwrap(), Language::Japanese);
    }

    #[test]
    fn language_from_str_by_iso_code() {
        assert_eq!("en".parse::<Language>().unwrap(), Language::English);
        assert_eq!("fr".parse::<Language>().unwrap(), Language::French);
        assert_eq!("ja".parse::<Language>().unwrap(), Language::Japanese);
    }

    #[test]
    fn language_from_str_case_insensitive() {
        assert_eq!("ENGLISH".parse::<Language>().unwrap(), Language::English);
        assert_eq!("English".parse::<Language>().unwrap(), Language::English);
        assert_eq!("eNgLiSh".parse::<Language>().unwrap(), Language::English);
    }

    #[test]
    fn language_from_str_unknown_returns_error() {
        let result = "klingon".parse::<Language>();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown language"));
    }
}
