// ============================================================================
// Amazon.in Search API Bulk Category Harvester
// ============================================================================
// Uses the reverse-engineered Amazon Search API (`POST /s/query`) inside
// Playwright with concurrent fetch workers to harvest unique products for
// 61 popular categories (11 original categories + 50 new popular categories,
// with at least 250 products per new category).
// Rule: No price rule; ONLY discount rule > 30% off.
// ============================================================================

const fs = require("fs");
const path = require("path");
const { parseSearchResultHtml } = require("./fetch-worker");

function loadPlaywrightChromium() {
  try {
    return require("playwright").chromium;
  } catch {
    return null;
  }
}

const DEFAULT_TARGET_PER_CATEGORY = 250;
const MIN_DISCOUNT_PCT = 50; // Prefer Discount >= 50% (fallback to any valid priced SKU)
const CONCURRENCY = 28;
const PLAYWRIGHT_CONCURRENCY = 16;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

const CATEGORIES = [
  // ── Original 11 Categories (500 SKUs each preserved) ──────────────────────
  {
    name: "sofa",
    target: 500,
    queries: [
      "sofa set for living room",
      "3 seater sofa",
      "l shape sofa set",
      "wooden sofa set",
      "2 seater sofa",
      "leatherette sofa",
      "fabric sofa set",
      "sectional sofa",
      "5 seater sofa set",
      "chesterfield sofa",
      "modern sofa living room",
      "velvet sofa",
    ],
  },
  {
    name: "almirah",
    target: 500,
    queries: [
      "almirah for clothes",
      "wooden wardrobe",
      "3 door wardrobe",
      "2 door wardrobe",
      "4 door wardrobe",
      "steel almirah",
      "sliding door wardrobe",
      "engineered wood wardrobe",
      "wardrobe with mirror",
      "bedroom almirah",
      "sheesham wood wardrobe",
      "metal almirah godrej",
    ],
  },
  {
    name: "recliner",
    target: 500,
    queries: [
      "recliner chair",
      "single seater recliner",
      "motorized recliner",
      "2 seater recliner sofa",
      "3 seater recliner",
      "rocking recliner chair",
      "leather recliner sofa",
      "fabric recliner chair",
      "home theater recliner",
      "living room recliner",
      "massage recliner chair",
      "swivel recliner",
    ],
  },
  {
    name: "sofa cum bed",
    target: 500,
    queries: [
      "sofa cum bed",
      "wooden sofa cum bed",
      "3 seater sofa cum bed",
      "folding sofa bed",
      "metal sofa cum bed",
      "convertible sofa bed",
      "futon sofa bed",
      "sofa cum bed with storage",
      "2 seater sofa cum bed",
      "pull out sofa bed",
      "fabric sofa cum bed",
      "sheesham wood sofa cum bed",
    ],
  },
  {
    name: "laptop",
    target: 500,
    queries: [
      "laptop",
      "gaming laptop",
      "intel core i5 laptop",
      "intel core i7 laptop",
      "amd ryzen 5 laptop",
      "amd ryzen 7 laptop",
      "thin and light laptop",
      "business laptop",
      "student laptop",
      "macbook air pro",
      "16gb ram laptop",
      "touchscreen laptop",
    ],
  },
  {
    name: "dining table",
    target: 500,
    queries: [
      "dining table 4 seater",
      "dining table 6 seater",
      "solid wood dining table set",
      "sheesham wood dining table",
      "marble top dining table",
      "glass top dining table set",
      "folding dining table",
      "2 seater dining table set",
      "8 seater dining table set",
      "round dining table set",
      "modern dining table with bench",
      "teak wood dining table",
    ],
  },
  {
    name: "office chair",
    target: 500,
    queries: [
      "ergonomic office chair",
      "high back mesh office chair",
      "executive office chair",
      "leatherette boss chair",
      "gaming chair office",
      "study desk chair ergonomic",
      "reclining office chair",
      "lumbar support office chair",
      "heavy duty office chair",
      "white ergonomic chair",
      "work from home chair",
      "adjustable headrest office chair",
    ],
  },
  {
    name: "speaker",
    target: 500,
    queries: [
      "party speaker",
      "dolby atmos soundbar",
      "home theater speaker 5.1",
      "portable bluetooth speaker",
      "bookshelf speakers",
      "tower speaker",
      "karaoke trolley speaker",
      "jbl bluetooth speaker",
      "sony speaker soundbar",
      "marshall speaker",
      "bose speaker",
      "subwoofer speaker system",
    ],
  },
  {
    name: "monitor",
    target: 500,
    queries: [
      "27 inch monitor",
      "gaming monitor",
      "4k uhd monitor",
      "32 inch monitor",
      "curved monitor",
      "24 inch ips monitor",
      "ultrawide monitor",
      "144hz gaming monitor",
      "type c monitor",
      "lg samsung dell benq monitor",
      "qhd 2k monitor",
      "portable monitor",
    ],
  },
  {
    name: "lux purse",
    target: 500,
    queries: [
      "luxury handbag women",
      "genuine leather handbag women",
      "designer tote bag women",
      "branded satchel bag women",
      "leather shoulder bag women",
      "aldo guess fossil handbag",
      "da milano hidesign leather bag",
      "luxury sling bag women",
      "premium women purse handbag",
      "michael kors coach handbag",
      "leather crossbody bag women",
      "luxury structured handbag",
    ],
  },
  {
    name: "watches",
    target: 500,
    queries: [
      "luxury watches for men",
      "automatic watch men",
      "chronograph watch men",
      "luxury watches for women",
      "fossil titan casio edifice watch",
      "seiko citizen tissot watch",
      "skeleton mechanical watch men",
      "smartwatch",
      "analog stainless steel watch men",
      "swiss watch men",
      "leather strap chronograph watch",
      "diving watch men",
    ],
  },

  // ── 50 New Popular Categories (At least 250 SKUs each, Discount > 30%) ────
  {
    name: "smartphone",
    target: 250,
    queries: [
      "5g smartphone",
      "android mobile phone",
      "samsung galaxy smartphone",
      "redmi xiaomi smartphone",
      "realme 5g mobile phone",
      "oneplusiqoo smartphone",
      "motorola vivo oppo smartphone",
      "gaming smartphone 5g",
      "8gb ram 256gb smartphone",
      "amoled display smartphone",
      "5000mah battery mobile phone",
      "dual sim unlocked smartphone",
    ],
  },
  {
    name: "tablet",
    target: 250,
    queries: [
      "android tablet",
      "wifi 5g calling tablet",
      "samsung galaxy tab",
      "lenovo tab tablet",
      "xiaomi redmi pad tablet",
      "apple ipad",
      "drawing graphics tablet",
      "11 inch display tablet",
      "student learning tablet",
      "tablet with stylus pen",
      "octa core tablet",
      "kids educational tablet",
    ],
  },
  {
    name: "television",
    target: 250,
    queries: [
      "4k ultra hd smart led tv",
      "55 inch smart tv",
      "43 inch 4k smart tv",
      "65 inch qled smart tv",
      "32 inch hd ready smart tv",
      "50 inch google tv",
      "qled dolby vision smart tv",
      "sony samsung lg smart tv",
      "xiaomi tcl hisense acer smart tv",
      "frameless android smart tv",
      "oled 4k television",
      "75 inch large screen smart tv",
    ],
  },
  {
    name: "headphones",
    target: 250,
    queries: [
      "wireless over ear headphones",
      "active noise cancelling headphones",
      "gaming headset with mic",
      "bluetooth headphones",
      "sony jbl sennheiser headphones",
      "boat zebronics noise headphones",
      "studio monitor headphones",
      "wired over ear headphones",
      "rgb pc gaming headphones",
      "foldable bass headphones",
      "workout gym headphones",
      "multipoint bluetooth headphones",
    ],
  },
  {
    name: "earbuds",
    target: 250,
    queries: [
      "tws true wireless earbuds",
      "anc noise cancelling earbuds",
      "bluetooth earphones",
      "gaming low latency earbuds",
      "neckband wireless earphones",
      "boat oneplus realme earbuds",
      "jbl sony samsung earbuds",
      "workout waterproof earbuds",
      "quad mic enc calling earbuds",
      "in ear wired earphones",
      "type c earphones",
      "spatial audio wireless earbuds",
    ],
  },
  {
    name: "camera",
    target: 250,
    queries: [
      "digital camera",
      "action camera 4k",
      "mirrorless camera",
      "dslr camera lens",
      "vlog camera youtube",
      "instant photo camera",
      "wifi security cctv camera",
      "dash cam car camera",
      "ptz outdoor security camera",
      "webcam 1080p 4k",
      "trail wildlife camera",
      "kids digital camera",
    ],
  },
  {
    name: "printer",
    target: 250,
    queries: [
      "all in one ink tank printer",
      "wifi colour printer",
      "laserjet monochrome printer",
      "hp canon epson brother printer",
      "duplex laser printer",
      "thermal label barcode printer",
      "portable mini photo printer",
      "inkjet home office printer",
      "scanner copier printer",
      "wireless colour inkjet printer",
      "receipt pos thermal printer",
      "printer ink toner cartridge",
    ],
  },
  {
    name: "projector",
    target: 250,
    queries: [
      "4k home theater projector",
      "full hd 1080p smart projector",
      "portable mini led projector",
      "android wifi bluetooth projector",
      "short throw projector",
      "outdoor movie projector",
      "auto keystone focus projector",
      "office presentation projector",
      "projector with screen",
      "rotatable smart projector",
      "gaming projector hdmi",
      "native 1080p projector",
    ],
  },
  {
    name: "refrigerator",
    target: 250,
    queries: [
      "double door frost free refrigerator",
      "single door direct cool refrigerator",
      "side by side refrigerator",
      "convertible inverter refrigerator",
      "samsung lg whirlpool refrigerator",
      "haier godrej bosch refrigerator",
      "mini portable car fridge",
      "bottom mount refrigerator",
      "3 star 5 star refrigerator",
      "glass door refrigerator",
      "triple door refrigerator",
      "deep freezer chiller",
    ],
  },
  {
    name: "washing machine",
    target: 250,
    queries: [
      "front load fully automatic washing machine",
      "top load fully automatic washing machine",
      "semi automatic washing machine",
      "7kg 8kg washing machine",
      "9kg inverter washing machine",
      "lg samsung bosch ifb washing machine",
      "whirlpool haier godrej washing machine",
      "washer dryer combo machine",
      "inbuilt heater washing machine",
      "6.5 kg automatic washing machine",
      "10kg heavy duty washing machine",
      "portable mini washing machine",
    ],
  },
  {
    name: "air conditioner",
    target: 250,
    queries: [
      "1.5 ton 5 star inverter split ac",
      "1.5 ton 3 star split ac",
      "1 ton inverter split ac",
      "2 ton split air conditioner",
      "window air conditioner",
      "lg daikin voltas carrier ac",
      "panasonic bluestar lloyd haier ac",
      "convertible 5 in 1 inverter ac",
      "smart wifi split ac",
      "hot and cold inverter split ac",
      "portable room air conditioner",
      "air cooler desert cooler",
    ],
  },
  {
    name: "microwave oven",
    target: 250,
    queries: [
      "convection microwave oven",
      "solo microwave oven",
      "grill microwave oven",
      "otg oven toaster griller",
      "20l 25l 30l microwave oven",
      "lg samsung ifb panasonic microwave",
      "morphy richards bajaj agaro otg",
      "built in microwave oven",
      "rotisserie baking oven",
      "digital touch microwave oven",
      "stainless steel cavity microwave",
      "pizza bread baking oven",
    ],
  },
  {
    name: "air fryer",
    target: 250,
    queries: [
      "digital air fryer for home",
      "philips air fryer",
      "agaro inalsa lifelong air fryer",
      "pigeon havells kent air fryer",
      "air fryer oven 12l",
      "4.5l 6l basket air fryer",
      "dual zone air fryer",
      "touchscreen oil free air fryer",
      "rotisserie air fryer oven",
      "see through window air fryer",
      "stainless steel air fryer",
      "deep fryer electric",
    ],
  },
  {
    name: "water purifier",
    target: 250,
    queries: [
      "ro uv uf water purifier",
      "copper alkaline water purifier",
      "aquaguard kent pureit water purifier",
      "livpure a o smith native water purifier",
      "stainless steel tank water purifier",
      "hot and normal water purifier",
      "under sink ro water purifier",
      "gravity non electric water purifier",
      "wall mounted ro water purifier",
      "mineralizer ro water filter",
      "8 stage water purifier",
      "water purifier filter kit",
    ],
  },
  {
    name: "vacuum cleaner",
    target: 1250,
    queries: [
      "cordless stick vacuum cleaner home",
      "wet and dry vacuum cleaner heavy duty",
      "handheld car vacuum cleaner high suction",
      "bagless canister vacuum cleaner",
      "eureka forbes vacuum cleaner home",
      "agaro wet dry vacuum cleaner",
      "philips bagless vacuum cleaner",
      "dyson cordless vacuum cleaner",
      "karcher wet and dry vacuum cleaner",
      "black decker vacuum cleaner",
      "inalsa wet and dry vacuum cleaner",
      "kent cyclonic vacuum cleaner",
      "bosch vacuum cleaner blower",
      "sofa carpet mattress uv vacuum cleaner",
      "blower vacuum cleaner home cleaning",
      "high suction cyclonic vacuum cleaner",
      "steam mop cleaner floor sanitizer",
      "upright vacuum cleaner for carpet",
      "pet hair vacuum cleaner cordless",
      "industrial heavy duty vacuum cleaner 20l 30l",
      "mini portable desk keyboard vacuum cleaner",
      "rechargeable cordless car vacuum cleaner",
      "hepa filter vacuum cleaner home",
      "carpet shampooer spot cleaner machine",
      "prestige typhoon vacuum cleaner",
      "dreame cordless stick vacuum cleaner",
      "xiaomi mi vacuum cleaner handheld",
      "lifelong vacuum cleaner for home",
      "american micronic vacuum cleaner",
      "bed mattress dust mite vacuum cleaner",
      "wet dry cordless floor washer vacuum",
      "multi surface vacuum cleaner attachments",
    ],
  },
  {
    name: "air purifier",
    target: 250,
    queries: [
      "hepa air purifier for home",
      "true hepa h13 room air purifier",
      "philips dyson coway mi air purifier",
      "honeywell sharp eureka forbes air purifier",
      "smart wifi pm2.5 air purifier",
      "car air purifier ionizer",
      "activated carbon air purifier",
      "bedroom silent air purifier",
      "uv sterilizer air purifier",
      "dehumidifier and air purifier",
      "ultrasonic cool mist humidifier",
      "hepa replacement filter air purifier",
    ],
  },
  {
    name: "geyser",
    target: 250,
    queries: [
      "15 litre storage water heater geyser",
      "25 litre storage water geyser",
      "instant water heater geyser 3l 5l",
      "bajaj crompton havells a o smith geyser",
      "racold v guard orient venus water heater",
      "5 star rated storage geyser",
      "gas geyser water heater",
      "horizontal wall mount geyser",
      "glasslined tank water heater",
      "smart wifi water heater",
      "10 litre bathroom geyser",
      "immersion water heater rod",
    ],
  },
  {
    name: "mixer grinder",
    target: 250,
    queries: [
      "750 watt mixer grinder 4 jars",
      "1000 watt heavy duty mixer grinder",
      "juicer mixer grinder",
      "prestige bajaj crompton philips mixer",
      "sujata butterfly preethi bosch mixer grinder",
      "nutri blender smoothie maker",
      "food processor kitchen machine",
      "hand blender chopper",
      "cold press slow juicer",
      "500w 3 jar mixer grinder",
      "wet grinder machine",
      "electric vegetable chopper",
    ],
  },
  {
    name: "induction cooktop",
    target: 250,
    queries: [
      "induction cooktop 2000 watt",
      "infrared induction stove",
      "philips prestige pigeon bajaj induction",
      "havells crompton v guard induction cooktop",
      "touch panel induction stove",
      "glass top 3 burner gas stove",
      "4 burner toughened glass gas stove",
      "auto ignition gas stove",
      "double induction cooktop",
      "slim portable induction stove",
      "stainless steel lpg gas stove",
      "electric hot plate cooking",
    ],
  },
  {
    name: "coffee maker",
    target: 250,
    queries: [
      "espresso coffee machine",
      "drip coffee maker for home",
      "20 bar cappuccino latte machine",
      "agaro morphy richards delonghi coffee maker",
      "nescafe philips wonderchef coffee machine",
      "bean to cup automatic coffee machine",
      "french press coffee maker",
      "coffee bean grinder electric",
      "milk frother handheld electric",
      "moka pot espresso maker",
      "cold brew coffee maker",
      "electric kettle temperature control",
    ],
  },
  {
    name: "dishwasher",
    target: 250,
    queries: [
      "free standing dishwasher 12 14 place",
      "countertop tabletop compact dishwasher",
      "bosch ifb Faber volbek dishwasher",
      "lg siemens hafele midea dishwasher",
      "8 place setting mini dishwasher",
      "built in integrated dishwasher",
      "stainless steel dishwasher machine",
      "intensive kadhai wash dishwasher",
      "auto open dry dishwasher",
      "fruit and vegetable washer cleaner",
      "ultrasonic kitchen sink cleaner",
      "high pressure washer cleaner",
    ],
  },
  {
    name: "ceiling fan",
    target: 250,
    queries: [
      "bldc energy saving ceiling fan with remote",
      "1200mm high speed ceiling fan",
      "decorative chandelier ceiling fan",
      "atomberg crompton havells orient ceiling fan",
      "bajaj usha polycab luminous ceiling fan",
      "pedestal stand fan high speed",
      "wall mounted oscillating fan",
      "tower fan for living room",
      "smart iot ceiling fan",
      "anti dust 4 blade ceiling fan",
      "table desk fan",
      "exhaust fan kitchen bathroom",
    ],
  },
  {
    name: "iron",
    target: 250,
    queries: [
      "steam iron for clothes",
      "garment steamer handheld vertical",
      "heavy weight dry iron",
      "philips bajaj crompton havells iron",
      "morphy richards usha orient tefal iron",
      "cordless steam iron",
      "2000w ceramic soleplate steam iron",
      "standing garment steamer",
      "travel mini foldable steam iron",
      "non stick teflon dry iron",
      "steam generator iron station",
      "ironing board foldable",
    ],
  },
  {
    name: "mattress",
    target: 250,
    queries: [
      "orthopedic memory foam mattress king size",
      "queen size mattress 6 inch 8 inch",
      "pocket spring mattress king queen",
      "wakefit sleepyhead sleepwell mattress",
      "kurlon duroflex Emma urban ladder mattress",
      "dual comfort reversible foam mattress",
      "natural latex mattress",
      "single bed mattress 72x36",
      "bonded foam back support mattress",
      "foldable travel floor mattress",
      "waterproof mattress protector",
      "memory foam mattress topper",
    ],
  },
  {
    name: "bed",
    target: 250,
    queries: [
      "king size bed with storage",
      "queen size engineered wood bed",
      "solid sheesham wood bed",
      "hydraulic box storage bed",
      "metal bed single double",
      "upholstered cushioned headboard bed",
      "single bed for bedroom",
      "poster bed solid wood",
      "folding rollaway bed with mattress",
      "bunk bed for kids",
      "wakefit nilkamal solitude wooden bed",
      "platform low height bed",
    ],
  },
  {
    name: "study table",
    target: 250,
    queries: [
      "study table for students wooden",
      "computer desk work from home table",
      "height adjustable electric standing desk",
      "gaming desk table with cable management",
      "folding wall mounted study table",
      "l shaped corner office desk",
      "solid wood writing table with drawers",
      "study table with bookshelf storage",
      "metal frame workstation desk",
      "portable foldable laptop bed table",
      "executive office table",
      "white modern computer desk",
    ],
  },
  {
    name: "dressing table",
    target: 250,
    queries: [
      "wooden dressing table with mirror and storage",
      "wall mounted dressing table",
      "vanity makeup table with stool and lights",
      "sheesham wood dressing table",
      "full length mirror dressing cabinet",
      "sliding mirror storage dressing table",
      "engineered wood bedroom dresser",
      "compact corner dressing table",
      "modern white vanity desk",
      "dressing table organizer cabinet",
      "led hollywood mirror vanity table",
      "chest of drawers bedroom dresser",
    ],
  },
  {
    name: "bookshelf",
    target: 250,
    queries: [
      "wooden bookshelf for home library",
      "open display rack bookcase",
      "bookshelf with glass doors",
      "corner ladder bookshelf",
      "sheesham wood bookcase cabinet",
      "5 tier metal wooden bookshelf",
      "wall mounted floating book shelf",
      "tree shaped desktop bookshelf",
      "kids toy and book storage organizer",
      "multipurpose storage cabinet rack",
      "cube organizer bookshelf",
      "revolving rotating bookshelf",
    ],
  },
  {
    name: "shoe rack",
    target: 250,
    queries: [
      "wooden shoe rack with door",
      "shoe cabinet with cushioned seat",
      "metal multi tier shoe rack",
      "plastic modular shoe organizer",
      "engineered wood entryway shoe cabinet",
      "sheesham wood shoe rack",
      "wall mounted slim tilting shoe cabinet",
      "zippered dustproof shoe rack",
      "6 tier 8 tier large shoe stand",
      "sneaker display storage box",
      "collapsible bamboo shoe rack",
      "bench style shoe storage",
    ],
  },
  {
    name: "tv unit",
    target: 250,
    queries: [
      "wooden tv entertainment unit living room",
      "wall mounted floating tv cabinet",
      "floor standing tv console table",
      "tv unit for 55 65 inch tv",
      "sheesham wood tv cabinet",
      "modern engineered wood media console",
      "tv stand with storage drawers shelves",
      "high gloss white tv unit",
      "set top box wifi router wall stand",
      "swivel floor tv mount stand",
      "corner tv cabinet wooden",
      "rustic industrial tv table",
    ],
  },
  {
    name: "coffee table",
    target: 250,
    queries: [
      "coffee table for living room",
      "wooden center table teapoy",
      "marble top coffee table gold frame",
      "round nesting coffee table set",
      "glass top center table",
      "sheesham wood coffee table with storage",
      "coffee table with 4 pouffe stools",
      "lift top convertible coffee table",
      "modern minimalist sofa side end table",
      "c shaped sofa snack table",
      "mid century wooden center table",
      "outdoor patio coffee table",
    ],
  },
  {
    name: "bean bag",
    target: 250,
    queries: [
      "xxl bean bag filled with beans",
      "bean bag with footrest and cushion",
      "xxxl leatherette bean bag lounge",
      "teardrop classic bean bag chair",
      "gaming bean bag chair",
      "fur velvet soft bean bag",
      "denim fabric bean bag",
      "soccer football bean bag",
      "sofa style structured bean bag",
      "inflatable lounge chair sofa",
      "bean bag refill beans 2kg",
      "pouffe ottoman foot stool",
    ],
  },
  {
    name: "treadmill",
    target: 250,
    queries: [
      "motorized folding treadmill for home",
      "under desk walking pad treadmill",
      "auto incline treadmill home gym",
      "cultsport powermax fitkit lifelong treadmill",
      "cockatoo sparnod durafit maxpro treadmill",
      "4hp 5hp peak dc motor treadmill",
      "manual multifunction treadmill",
      "heavy duty commercial gym treadmill",
      "compact flat fold walking machine",
      "massager twister treadmill",
      "elliptical cross trainer machine",
      "rowing machine home fitness",
    ],
  },
  {
    name: "exercise cycle",
    target: 250,
    queries: [
      "exercise cycle for home gym weight loss",
      "indoor spinning stationary bike",
      "air bike with moving handles",
      "magnetic resistance upright exercise bike",
      "recumbent exercise bike for seniors",
      "cultsport powermax lifelong reach exercise cycle",
      "foldable x bike fitness cycle",
      "under desk pedal exerciser mini bike",
      "bluetooth smart spin bike",
      "flywheel gym spin cycle",
      "home gym multi station equipment",
      "adjustable weight bench dumbbell set",
    ],
  },
  {
    name: "bicycle",
    target: 250,
    queries: [
      "mountain cycle mtb 21 speed geared",
      "adult bicycle 26t 27.5t 29t",
      "hybrid city commuter bicycle",
      "single speed cycle for men women",
      "electric cycle e-bike rechargeable",
      "hero hercules firefox urban terrain cycle",
      "cradiac leader ninety one Montague bicycle",
      "fat tyre mountain bicycle",
      "foldable adult bicycle",
      "kids bicycle 14t 16t 20t",
      "disc brake suspension mtb cycle",
      "ladies basket bicycle",
    ],
  },
  {
    name: "trolley bag",
    target: 250,
    queries: [
      "hard sided cabin trolley bag 55cm",
      "set of 3 luggage trolley bags",
      "medium check in suitcase 65cm",
      "large travel suitcase 75cm",
      "safari american tourister vip skybags trolley",
      "mokobara uppercase aristocrat kamiliant luggage",
      "polycarbonate 8 wheel spinner suitcase",
      "tsa lock hard luggage bag",
      "soft sided expandable trolley bag",
      "duffle trolley bag with wheels",
      "kids ride on scooter suitcase",
      "laptop overnighter cabin roller bag",
    ],
  },
  {
    name: "backpack",
    target: 250,
    queries: [
      "laptop backpack 15.6 inch",
      "waterproof anti theft travel backpack",
      "trekking hiking rucksack 60l 70l",
      "office business backpack men women",
      "american tourister wildcraft skybags safari backpack",
      "mokobara Tommy Hilfiger arctic hunter backpack",
      "college school bag backpack",
      "usb charging port backpack",
      "camera dslr lens backpack",
      "overnight expandable travel backpack",
      "gym sports duffle bag",
      "leather laptop messenger bag",
    ],
  },
  {
    name: "running shoes",
    target: 250,
    queries: [
      "running shoes for men",
      "sports training gym shoes men",
      "women running walking shoes",
      "nike adidas puma reebok running shoes",
      "skechers asics new balance under armour shoes",
      "campus sparx red tape asian sports shoes",
      "marathon carbon plate running shoes",
      "memory foam walking sneakers",
      "badminton tennis court shoes",
      "trail running trekking shoes",
      "casual white sneakers men women",
      "slip on lightweight walking shoes",
    ],
  },
  {
    name: "sunglasses",
    target: 250,
    queries: [
      "polarized uv protection sunglasses men",
      "oversized sunglasses for women",
      "aviator sunglasses men women",
      "wayfarer square sunglasses",
      "ray ban oakley Carrera polaroid sunglasses",
      "vincent chase fastrack idee voyage sunglasses",
      "retro round vintage sunglasses",
      "sports cycling driving sunglasses",
      "photochromic night driving glasses",
      "cat eye designer sunglasses women",
      "clubmaster browline sunglasses",
      "blue cut computer eyeglasses",
    ],
  },
  {
    name: "perfume",
    target: 250,
    queries: [
      "eau de parfum for men long lasting",
      "luxury perfume for women",
      "arabian oud perfume lattafa armaf",
      "davidoff calvin klein versace jaguar perfume",
      "titan skinn bella vita Ajmal rasasi perfume",
      "unisex niche fragrance edp",
      "perfume gift set for men women",
      "french woody aquatic perfume men",
      "floral vanilla musk perfume women",
      "cologne eau de toilette spray",
      "pocket solid travel perfume",
      "attar non alcoholic roll on fragrance",
    ],
  },
  {
    name: "trimmer",
    target: 250,
    queries: [
      "beard trimmer for men cordless",
      "all in one multi grooming kit men",
      "electric rotary foil shaver men",
      "philips braun panasonic mi beard trimmer",
      "havells nova vega syska bombay shaving trimmer",
      "waterproof body hair groomer",
      "professional zero gapped hair clipper",
      "women epilator bikini trimmer",
      "nose and ear hair trimmer",
      "fast charging type c beard trimmer",
      "titanium blade hair cutting machine",
      "grooming trimmer gift set",
    ],
  },
  {
    name: "hair dryer",
    target: 250,
    queries: [
      "ionic hair dryer 2000w professional",
      "ceramic hair straightener flat iron",
      "hot air brush styler volumizer",
      "philips dyson ikonic agaro hair dryer",
      "havells vega morphy richards syska hair styler",
      "3 in 1 hair crimper curler straightener",
      "foldable travel hair dryer",
      "automatic rotating hair curler tong",
      "hair straightening heated brush",
      "cool shot diffuser hair dryer",
      "keratininfused hair straightener",
      "multi styler airwrap hair kit",
    ],
  },
  {
    name: "massager",
    target: 250,
    queries: [
      "electric leg and foot massager machine",
      "deep tissue percussion massage gun",
      "shiatsu neck and shoulder massager with heat",
      "agaro lifelong caresmith dr physio massager",
      "full back massage chair pad cushion",
      "head scalp massager electric",
      "eye massager with heat bluetooth",
      "handheld full body vibrator massager",
      "knee joint heat therapy massager",
      "foot spa pedicure massager roller",
      "compression air bag leg massager",
      "tens muscle stimulator machine",
    ],
  },
  {
    name: "power bank",
    target: 250,
    queries: [
      "20000mah fast charging power bank",
      "10000mah slim pocket power bank",
      "magsafe magnetic wireless power bank",
      "30000mah high capacity power bank",
      "mi redmi ambrane urbn spigen power bank",
      "anker stuffcool boat portronics power bank",
      "65w 100w laptop charging power bank",
      "power bank with built in cables",
      "22.5w pd quick charge power bank",
      "solar waterproof camping power bank",
      "gan fast charger 65w type c",
      "3 in 1 wireless charging station",
    ],
  },
  {
    name: "external ssd",
    target: 250,
    queries: [
      "1tb portable external ssd usb c",
      "2tb external hard drive hdd",
      "nvme m.2 internal ssd 1tb",
      "sandisk samsung crucial western digital ssd",
      "seagate toshiba kingston lexar external drive",
      "4tb backup desktop external hard disk",
      "sata 2.5 inch internal ssd 500gb 1tb",
      "gen4 pcie nvme ssd ps5",
      "high speed type c dual pen drive",
      "micro sdxc memory card 256gb 512gb",
      "nvme ssd enclosure type c",
      "nas network storage drive",
    ],
  },
  {
    name: "router",
    target: 250,
    queries: [
      "wifi 6 dual band gigabit router",
      "mesh wifi system whole home",
      "ac1200 dual band wireless router",
      "tp link netgear asus tenda dlink router",
      "4g 5g sim card wifi router",
      "wifi range extender signal booster",
      "ax3000 ax1800 gaming wifi 6 router",
      "8 port gigabit ethernet switch",
      "usb wifi bluetooth adapter pc",
      "portable pocket 4g lte mifi hotspot",
      "outdoor weatherproof wifi access point",
      "fiber optic onu GPON router",
    ],
  },
  {
    name: "keyboard",
    target: 250,
    queries: [
      "wireless mechanical gaming keyboard",
      "rgb hot swappable mechanical keyboard",
      "wireless keyboard and mouse combo",
      "bluetooth multi device compact keyboard",
      "logitech razer cosmic byte redragon keyboard",
      "kreo aula royal kludge keychron portronics keyboard",
      "ergonomic split wave keyboard",
      "60 percent 75 percent mechanical keyboard",
      "backlit membrane gaming keyboard",
      "foldable bluetooth tablet ipad keyboard",
      "silent office wireless keyboard combo",
      "custom coiled cable keycaps keyboard",
    ],
  },
  {
    name: "gaming mouse",
    target: 250,
    queries: [
      "lightweight wireless gaming mouse",
      "rgb optical gaming mouse wired",
      "ergonomic vertical wireless mouse",
      "logitech g razer hyperx corsair gaming mouse",
      "redragon cosmic byte kreo archer gaming mouse",
      "bluetooth silent rechargeable mouse",
      "honeycomb shell ultralight gaming mouse",
      "programmable macro mmo gaming mouse",
      "trackball ergonomic thumb mouse",
      "xxl extended rgb gaming mouse pad",
      "wireless presentation air mouse",
      "dual mode 2.4ghz bluetooth mouse",
    ],
  },
  {
    name: "graphics card",
    target: 250,
    queries: [
      "rtx gaming graphics card gpu",
      "amd radeon rx graphics card",
      "geforce rtx 4060 3060 graphics card",
      "asus msi gigabyte zotac inno3d gpu",
      "gaming motherboard am5 lga1700",
      "liquid cpu cooler aio 240mm 360mm",
      "ddr5 ddr4 gaming ram 16gb 32gb",
      "80 plus gold modular power supply psu",
      "mid tower argb gaming pc cabinet case",
      "amd ryzen intel core processor cpu",
      "capture card 4k hdmi streaming",
      "ups for gaming pc",
    ],
  },
  {
    name: "ups inverter",
    target: 250,
    queries: [
      "1000va 600va line interactive computer ups",
      "pure sine wave home inverter",
      "apc microtek luminous zebronics artisan ups",
      "v guard exide amaron inverter battery",
      "wifi router mini ups power backup",
      "150ah tubular inverter battery",
      "online ups 1kva 2kva",
      "portable solar power station generator",
      "automatic voltage stabilizer ac tv",
      "surge protector power strip extension board",
      "smart plug energy monitor",
      "solar inverter hybrid",
    ],
  },
  {
    name: "hdd",
    target: 250,
    queries: [
      "external hard disk drive 1tb 2tb",
      "internal desktop hdd 3.5 inch sata",
      "laptop internal hard drive 2.5 inch",
      "seagate western digital wd toshiba hdd",
      "4tb 5tb portable external hard disk",
      "surveillance cctv hard disk drive",
      "nas hard drive ironwolf wd red",
      "usb 3.0 external hard drive backup",
      "desktop internal hard disk 1tb 2tb 4tb",
      "external hdd shockproof case",
      "hard disk enclosure 2.5 3.5 sata usb",
      "gaming external hard drive ps5 xbox",
    ],
  },
  {
    name: "ssd",
    target: 250,
    queries: [
      "nvme m.2 pcie internal ssd",
      "sata 2.5 inch internal ssd",
      "gen4 nvme m.2 ssd 1tb 2tb",
      "500gb 512gb internal ssd laptop",
      "samsung wd black crucial kingston nvme ssd",
      "adata xpg lexar silicon power teamgroup ssd",
      "evm consistent zebronics ant esports ssd",
      "ps5 heatsink m.2 nvme ssd",
      "portable usb 3.2 type c ssd",
      "256gb sata m.2 internal ssd",
      "4tb high speed nvme ssd",
      "msata mini pcie internal ssd",
    ],
  },
  {
    name: "ram",
    target: 250,
    queries: [
      "ddr4 desktop ram 8gb 16gb 3200mhz",
      "ddr5 desktop gaming ram 16gb 32gb",
      "laptop sodimm ddr4 ram 8gb 16gb",
      "laptop sodimm ddr5 ram 16gb 32gb",
      "corsair vengeance g.skill trident z rgb ram",
      "crucial kingston fury xpg adata gaming ram",
      "teamgroup patriot silicon power desktop ram",
      "evm consistent hynix samsung laptop ram",
      "3600mhz cl16 cl18 gaming ddr4 ram",
      "6000mhz 5600mhz ddr5 rgb ram kit",
      "ddr3 8gb 4gb 1600mhz desktop laptop ram",
      "32gb kit 2x16gb dual channel ram",
    ],
  },

  // ── 40 Additional Popular Categories (+10,000 Products, 250 SKUs each) ────
  {
    name: "kitchen chimney",
    target: 250,
    queries: [
      "auto clean kitchen chimney 60cm 90cm",
      "filterless baffle filter kitchen chimney",
      "elica faber glen hindware kitchen chimney",
      "kaff sunflame crompton blowhot chimney",
      "curved glass wall mounted chimney",
      "slant incline motion sensor chimney",
      "1200 m3/hr 1400 m3/hr suction chimney",
      "bldc motor silent kitchen chimney",
      "built in kitchen hob 3 4 burner",
      "island modular kitchen chimney",
      "straight line ductless kitchen chimney",
      "kitchen exhaust hood chimney",
    ],
  },
  {
    name: "cookware set",
    target: 250,
    queries: [
      "non stick cookware set induction base",
      "triply stainless steel cookware set",
      "cast iron skillet kadai tawa cookware",
      "prestige hawkins pigeon wonderchef cookware",
      "meyer bergner vinod stahl tramontina cookware",
      "granite finish non stick frying pan kadai",
      "ceramic coating non toxic cookware set",
      "hard anodized pressure cooker 3l 5l",
      "stainless steel outer lid pressure cooker",
      "cast iron dutch oven casserole",
      "idli maker steamer multi kadai",
      "kitchen cooking utensil gift set",
    ],
  },
  {
    name: "dinner set",
    target: 250,
    queries: [
      "opalware dinner set 35 pieces",
      "bone china crockery dinner set",
      "melamine dinner set 32 40 pieces",
      "cello la opala borosil larah dinner set",
      "corelle milton signoraware stainless dinner set",
      "ceramic handpainted dinner plates bowls",
      "6 seater 8 seater dining crockery set",
      "microwave safe glass bowl set",
      "tea cup and saucer gift set",
      "casserole hot pot set of 3",
      "porcelain luxury dinnerware set",
      "brass kansa bronze thali dinner set",
    ],
  },
  {
    name: "electric kettle",
    target: 250,
    queries: [
      "stainless steel electric kettle 1.5l 1.8l",
      "double wall cool touch electric kettle",
      "glass electric kettle with led light",
      "multipurpose electric kettle steamer cooker",
      "havells philips prestige pigeon electric kettle",
      "milton butterfly bajaj wipro agaro kettle",
      "gooseneck pour over coffee electric kettle",
      "temperature control variable electric kettle",
      "travel foldable mini electric kettle",
      "tea infuser electric glass kettle",
      "egg boiler electric automatic poacher",
      "pop up bread toaster 2 slice 4 slice",
    ],
  },
  {
    name: "sandwich maker",
    target: 250,
    queries: [
      "electric grill sandwich maker",
      "3 in 1 waffle grill toaster sandwich maker",
      "borosil prestige bajaj kent sandwich maker",
      "philips morphy richards agaro wipro grill",
      "panini press contact electric grill",
      "4 slice jumbo grill sandwich maker",
      "belgian waffle maker iron electric",
      "detachable plate non stick sandwich toaster",
      "electric barbecue grill indoor table",
      "roti maker chapati maker electric",
      "donut cupcake snacks maker electric",
      "popcorn maker machine home",
    ],
  },
  {
    name: "room heater",
    target: 250,
    queries: [
      "oil filled radiator room heater 9 11 13 fin",
      "fan room heater blower 2000w",
      "ptc ceramic tower fan room heater",
      "quartz halogen infrared room heater",
      "bajaj orient havells crompton room heater",
      "morphy richards usha orpat solimo heater",
      "carbon fiber room warmer heater",
      "wall mounted bathroom fan heater",
      "convection room heater with thermostat",
      "portable mini plug in room heater",
      "electric bed warmer heating blanket",
      "halogen 3 rod room heater",
    ],
  },
  {
    name: "sewing machine",
    target: 250,
    queries: [
      "electric automatic zig zag sewing machine",
      "portable mini sewing machine table",
      "usha janome singer brother sewing machine",
      "bernette merritt jack computerized sewing machine",
      "heavy duty tailoring sewing machine",
      "overlock interlock sewing machine",
      "embroidery computerized sewing machine",
      "handheld portable stitch machine",
      "sewing machine motor pedal stand kit",
      "composite domestic silai machine",
      "quilting patchwork sewing machine",
      "bag closer stitching machine",
    ],
  },
  {
    name: "curtains",
    target: 250,
    queries: [
      "blackout window curtains 5 feet 7 feet",
      "long door curtains 8 feet 9 feet living room",
      "sheer net white curtains bedroom",
      "velvet heavy thermal insulated curtains",
      "urban space story@home cortina curtains",
      "ddecor spaces homemonde cotton curtains",
      "floral printed eyelet ring curtains",
      "geometric jacquard blackout curtains",
      "roller zebra blinds for windows",
      "macrame bohemian door string curtain",
      "waterproof pvc balcony outdoor curtain",
      "motorized curtain track rod set",
    ],
  },
  {
    name: "bedsheet",
    target: 250,
    queries: [
      "100% cotton king size bedsheet with pillow covers",
      "fitted elastic king size bedsheet",
      "300 tc 400 tc glacé cotton double bedsheet",
      "jaipuri rajasthani print cotton bedsheet",
      "bombay dyeing trident spaces ddecor bedsheet",
      "story@home haus kinder divine casa bedsheet",
      "reversible ac comforter blanket double bed",
      "duvet cover king size white microfibre",
      "mink winter heavy blanket double bed",
      "quilted bed cover bedspread set",
      "satin silk luxury bedsheet set",
      "kids cartoon single bedsheet cotton",
    ],
  },
  {
    name: "carpet rug",
    target: 250,
    queries: [
      "shaggy fluffy area rug carpet living room",
      "persian traditional woven floor carpet",
      "5x7 6x9 feet bedroom living room rug",
      "anti skid washable runner rug hallway",
      "cotton braided jute round floor rug",
      "status saral home obeetee jaipur rugs carpet",
      "abstract modern geometric area carpet",
      "artificial grass turf mat balcony",
      "kids play mat foam reversible rug",
      "microfiber bath mat door mat set",
      "prayer mat velvet janamaz carpet",
      "interlocking eva gym floor tiles",
    ],
  },
  {
    name: "chandelier light",
    target: 250,
    queries: [
      "modern crystal chandelier ceiling light living room",
      "hanging pendant lamp dining table light",
      "3 color dimmable remote led chandelier",
      "duplex staircase long crystal chandelier",
      "antique brass vintage jhumar chandelier",
      "philips wipro havells orient wall ceiling lamp",
      "standing floor lamp with shelf living room",
      "bedside table night lamp ceramic wooden",
      "led track light cob spotlight ceiling",
      "outdoor waterproof garden gate wall light",
      "neon led sign wall decor light",
      "rechargeable emergency study desk lamp",
    ],
  },
  {
    name: "wall decor",
    target: 250,
    queries: [
      "metal wall art decor living room large",
      "framed canvas painting set for wall",
      "decorative silent wall clock living room",
      "led backlit bathroom vanity wall mirror",
      "full length standing floor mirror",
      "wooden floating wall shelves home decor",
      "buddha idol statue showpiece home decor",
      "artificial indoor large plant with pot",
      "macrame wall hanging boho decor",
      "key holder wall organizer wooden metal",
      "fountain indoor tabletop waterfall",
      "collage photo frames wall set",
    ],
  },
  {
    name: "bathroom fittings",
    target: 250,
    queries: [
      "rain shower head 8 inch 12 inch with arm",
      "stainless steel bathroom accessories set",
      "wall mixer diverter faucet tap bathroom",
      "hindware jaquar cera parryware kohler faucet",
      "plantex ruhe altonibo brass basin mixer",
      "kitchen sink pull out sprayer mixer tap",
      "304 stainless steel handmade kitchen sink",
      "wall mounted folding towel rack bathroom",
      "ceramic table top wash basin counter",
      "health faucet jet spray stainless steel",
      "corner shelf bathroom caddy adhesive",
      "sensor automatic touchless basin tap",
    ],
  },
  {
    name: "cctv security",
    target: 250,
    queries: [
      "360 degree wifi smart security camera indoor",
      "outdoor bullet 4g sim solar cctv camera",
      "cp plus hikvision dahua 4 channel 8 channel dvr kit",
      "tp link tapo xiaomi mi qubo imou security camera",
      "smart fingerprint digital door lock",
      "video doorbell camera wireless wifi",
      "dual lens ptz outdoor floodlight camera",
      "biometric attendance machine office",
      "electronic digital safe locker for home",
      "godrej ozone yale smart door lock",
      "nvr poe ip camera security system",
      "baby monitor camera with screen",
    ],
  },
  {
    name: "power tools",
    target: 250,
    queries: [
      "impact drill machine kit 13mm home tool set",
      "cordless screwdriver drill machine 12v 20v",
      "bosch stanley black decker makita drill",
      "dewalt ingco ibell cheetah angle grinder",
      "rotary hammer drill machine sds plus",
      "electric blower vacuum cleaner tool",
      "marble cutter wood circular saw machine",
      "high pressure car washer pump 1800w 2200w",
      "inverter arc welding machine igbt",
      "socket wrench spanner tool kit box",
      "hot air heat gun soldering station",
      "laser distance meter level measurement",
    ],
  },
  {
    name: "car accessories",
    target: 250,
    queries: [
      "dual channel 4k car dash cam front rear",
      "digital tyre inflator air compressor car",
      "wireless apple carplay android auto stereo",
      "70mai qubo ddpai redtiger dashcam",
      "portronics Michelin agaro bergmann tyre inflator",
      "high power car vacuum cleaner portable",
      "car seat organizer memory foam neck rest",
      "custom fit 7d car floor mats",
      "led headlight bulb h4 h7 120w car",
      "gps tracker for car bike hidden",
      "waterproof car body cover uv protection",
      "jump starter power bank car battery",
    ],
  },
  {
    name: "helmet riding",
    target: 250,
    queries: [
      "full face isi dot ece certified helmet",
      "modular flip up bluetooth motorcycle helmet",
      "axor smk mt vega studds steelbird helmet",
      "royal enfield ls2 kyt ignyte bike helmet",
      "motorcycle riding jacket with ce armor",
      "riding gloves knuckle protection waterproof",
      "bike mobile holder with charger metal",
      "motorcycle intercom bluetooth headset",
      "saddle bag tail bag magnetic tank bag",
      "knee elbow guard riding gear set",
      "fog light projector led motorcycle",
      "open face half helmet scooter men women",
    ],
  },
  {
    name: "musical instruments",
    target: 250,
    queries: [
      "acoustic guitar 38 40 inch cutaway",
      "61 key portable electronic keyboard piano",
      "yamaha casio fender cort kadence guitar",
      "juarez intern vault revel soprano ukulele",
      "88 key weighted digital piano",
      "electric guitar with amplifier combo",
      "electronic drum kit mesh head",
      "cajon box percussion drum instrument",
      "condenser microphone audio interface studio",
      "violin 4/4 full size with bow case",
      "flute harmonica kalimba instrument",
      "dj controller mixer pioneer numark",
    ],
  },
  {
    name: "gaming console",
    target: 250,
    queries: [
      "playstation 5 ps5 console disc slim",
      "wireless gaming controller gamepad pc android",
      "xbox series x s wireless controller",
      "racing steering wheel with pedals shifter",
      "nintendo switch oled handheld console",
      "vr headset meta quest virtual reality",
      "ps5 dualsense controller charging station",
      "logitech thrustmaster cosmic byte racing wheel",
      "8bitdo gamesir evo fox wireless gamepad",
      "ps5 ps4 gaming dvd titles",
      "retro handheld game console 4k tv",
      "arcade fight stick joystick controller",
    ],
  },
  {
    name: "smartwatch",
    target: 250,
    queries: [
      "amoled bluetooth calling smartwatch",
      "gps fitness tracker smart watch men women",
      "samsung galaxy watch apple watch",
      "amazfit garmin huawei oneplus smartwatch",
      "fastrack titan noise boat fireboltt smartwatch",
      "rugged outdoor military smart watch",
      "round dial stainless steel smartwatch",
      "kids 4g gps video call smart watch",
      "smart ring fitness sleep health tracker",
      "ecg spo2 heart rate smart band",
      "always on display luxury smartwatch",
      "rotating crown wireless charging watch",
    ],
  },
  {
    name: "jewellery",
    target: 250,
    queries: [
      "925 sterling silver necklace earrings women",
      "american diamond cz choker jewellery set",
      "giva clara zavya kushals fashion jewellery",
      "swarovski crystals bracelet pendant women",
      "kundan pearl traditional bridal necklace set",
      "gold plated temple jewellery haram set",
      "silver anklets payal toe ring women",
      "men sterling silver chain bracelet ring",
      "oxidised silver boho jhumka earrings",
      "rose gold solitaire ring adjustable",
      "mangalsutra diamond gold plated women",
      "velvet jewellery organizer storage box",
    ],
  },
  {
    name: "mens ethnic",
    target: 250,
    queries: [
      "men silk blend kurta pyjama set wedding",
      "nehru modi jacket waistcoat with kurta",
      "manyavar sojanya vastramay kiswah kurta",
      "men embroidered sherwani indo western set",
      "cotton chikankari pathani kurta men",
      "men jodhpuri bandhgala blazer suit",
      "floral printed haldi mehendi kurta men",
      "dhoti kurta set silk men festive",
      "short cotton linen kurta shirt men",
      "ethnic mojaris jutti loafers men",
      "pashmina shawl stole for men",
      "men sequence party wear kurta",
    ],
  },
  {
    name: "womens ethnic",
    target: 250,
    queries: [
      "women embroidered kurta pant dupatta set",
      "banarasi kanjivaram pure silk saree",
      "biba w for woman aurelia libas kurta set",
      "indo era janasyasangria anarkali suit",
      "organza georgette party wear saree",
      "ready to wear stitched lehenga choli",
      "cotton printed straight kurti palazzo set",
      "velvet embroidered bridal shawl dupatta",
      "chanderi silk festive salwar suit set",
      "sharara garara suit set wedding women",
      "chikankari lucknowi georgette kurti",
      "designer blouse readymade padded saree",
    ],
  },
  {
    name: "mens clothing",
    target: 250,
    queries: [
      "men slim fit formal suit blazer 2 piece",
      "men winter puffer leather biker jacket",
      "levis pepe jeans wrangler spykar men jeans",
      "us polo assn allen solly louis philippe shirt",
      "van heusen peter england arrow formal trousers",
      "men cotton polo t shirt pack combo",
      "oversized fleece hoodie sweatshirt men",
      "cargo pants joggers track pants men",
      "pure linen casual shirt men full sleeve",
      "men thermal innerwear winter top bottom",
      "waterproof windcheater rain jacket men",
      "men tuxedo waistcoat party blazer",
    ],
  },
  {
    name: "womens western",
    target: 250,
    queries: [
      "women maxi midi a-line party dress",
      "women formal office blazer coat pant suit",
      "vero moda only mango marks spencer dress",
      "levis kraus madame forever 21 women jeans",
      "high waist wide leg Korean trousers women",
      "winter trench coat woollen cardigan women",
      "floral chiffon tops tunics women",
      "co-ord set for women western stylish",
      "jumpsuit playsuit evening party wear",
      "gym activewear sports bra leggings set",
      "denim jacket faux leather jacket women",
      "satin night suit loungewear pajamas women",
    ],
  },
  {
    name: "formal shoes",
    target: 250,
    queries: [
      "men genuine leather oxford formal shoes",
      "slip on leather loafers moccasins men",
      "hush puppies clarks bata red tape leather shoes",
      "woodland lee cooper ruosh louis stitch boots",
      "chelsea ankle leather boots men",
      "derby brogue tan brown formal shoes",
      "women block heel pumps stilettos sandals",
      "metro mochi catwalk inc 5 heels women",
      "crocs clogs waterproof sandals men women",
      "birkenstock cork footbedflat sliders",
      "leather wallet and belt gift combo men",
      "orthopedic diabetic comfort sandals",
    ],
  },
  {
    name: "baby stroller",
    target: 250,
    queries: [
      "foldable baby stroller pram buggy travel",
      "convertible baby car seat isofix 0-12 years",
      "luvlap r for rabbit chicco graco stroller",
      "mee mee star and daisy fisher price baby",
      "wooden baby cot crib bed with mosquito net",
      "baby high chair dining booster seat",
      "ergonomic baby carrier kangaroo bag",
      "electric breast pump double wearable",
      "uv baby bottle sterilizer warmer dryer",
      "baby walker rocker activity center",
      "diaper bag backpack waterproof maternity",
      "kids battery operated ride on car jeep",
    ],
  },
  {
    name: "toys games",
    target: 250,
    queries: [
      "lego building blocks technic creator set",
      "remote control rc monster truck stunt car",
      "camera drone foldable quadcopter brushless",
      "hot wheels track set diecast cars",
      "nerf blaster motorized dart gun",
      "barbie doll house kitchen playset",
      "magnetic tiles building blocks stem toy",
      "board gamesatan monopoly scrabble chess",
      "kids electric scooter hoverboard skate",
      "wooden montessori educational puzzle toy",
      "giant teddy bear soft plush toy",
      "telescope microscope science kit kids",
    ],
  },
  {
    name: "sports fitness",
    target: 250,
    queries: [
      "adjustable dumbbell set home gym 20kg 40kg",
      "kashmir English willow leather cricket bat",
      "yonex li-ning Victor carbon badminton racket",
      "cosco nivia spalding wilson basketball football",
      "olympic barbell rod rubber weight plates",
      "tpe non slip yoga mat 6mm 8mm with bag",
      "pull up bar wall mounted dip station",
      "boxing kit punching bag gloves filled",
      "roller skates inline professional adjustable",
      "table tennis table racket ping pong",
      "swimming goggles cap fins snorkel kit",
      "camping tent 4 person waterproof sleeping bag",
    ],
  },
  {
    name: "protein supplements",
    target: 250,
    queries: [
      "100% whey protein isolate powder 1kg 2kg",
      "optimum nutrition muscleblaze avvatar whey",
      "asitis myprotein nakpro gnc dymatize protein",
      "creatine monohydrate micronized powder",
      "mass gainer weight gainer protein 3kg",
      "plant pea brown rice vegan protein powder",
      "bcaa eaa pre workout energy drink",
      "omega 3 fish oil triple strength capsules",
      "multivitamin tablets men women immunity",
      "collagen peptides biotin skin hair supplement",
      "ashwagandha shilajit gold resin ayurvedic",
      "peanut butter crunchy unsweetened 1kg",
    ],
  },
  {
    name: "skincare beauty",
    target: 250,
    queries: [
      "vitamin c niacinamide hyaluronic face serum",
      "spf 50 pa++++ sunscreen gel matte",
      "minimalist derma co plum dot key skincare",
      "cetaphil cerave neutrogena bioderma lotion",
      "loreal olaplex Schwarzkopf keratin hair mask",
      "korean snail mucin essence glass skin kit",
      "retinol anti aging night cream under eye",
      "professional makeup brush vanity kit",
      "maybelline mac lakme huda beauty lipstick palette",
      "facial kit salon gold diamond bridal",
      "rosemary hair growth oil serum",
      "ultrasonic skin scrubber led face mask",
    ],
  },
  {
    name: "medical devices",
    target: 250,
    queries: [
      "digital automatic blood pressure monitor arm",
      "omron dr trust dr morepen Beurer bp machine",
      "glucometer blood sugar test strips machine",
      "compressor nebulizer machine kids adults",
      "fingertip pulse oximeter spo2 monitor",
      "digital body weight smart bmi scale",
      "infrared forehead ear thermometer gun",
      "orthopedic lumbar back support belt knee brace",
      "folding wheelchair commode walker stick",
      "hearing aid rechargeable digital machine",
      "air mattress anti bedsore hospital bed",
      "electric heating pad ortho pain relief",
    ],
  },
  {
    name: "pet supplies",
    target: 250,
    queries: [
      "pedigree royal canin drools adult dog food 10kg",
      "whiskas me-o purina sheba cat food dry wet",
      "orthopedic washable large dog bed cushion",
      "cat tree scratching post condo tower",
      "automatic smart pet feeder water fountain",
      "pet grooming vacuum clipper trimmer kit",
      "retractable dog leash harness collar set",
      "airline approved pet travel carrier cage",
      "clumping bentonite tofu cat litter 10l",
      "aquarium glass fish tank filter led light",
      "dog chew bones treats dental sticks",
      "Heavy duty metal dog crate kennel",
    ],
  },
  {
    name: "gardening outdoor",
    target: 250,
    queries: [
      "outdoor patio garden balcony table chair set",
      "hanging swing hammock chair jhula indoor outdoor",
      "ceramic fiber plastic plant pots set of 5",
      "electric lawn mower grass trimmer brush cutter",
      "solar garden pathway waterproof led lights",
      "expandable garden water hose pipe spray gun",
      "heavy duty metal plant stand rack balcony",
      "automatic drip irrigation watering kit",
      "barbecue charcoal grill portable outdoor",
      "garden pruning shears tool kit bag",
      "shade net green house uv stabilized",
      "bird feeder house hanging wooden",
    ],
  },
  {
    name: "office supplies",
    target: 250,
    queries: [
      "cross cut paper shredder machine office",
      "thermal laminator machine a4 a3 pouch",
      "currency cash counting machine fake note detector",
      "whiteboard magnetic marker board 4x3 feet",
      "parker lamy cross sheaffer fountain roller pen",
      "casio scientific financial desktop calculator",
      "label maker printer handheld bluetooth",
      "desk organizer file tray pen stand wooden",
      "spiral comb binding machine office",
      "fireproof waterproof document bag safe",
      "acrylic sign holder notice display board",
      "executive leather diary notebook gift set",
    ],
  },
  {
    name: "motherboard cpu",
    target: 250,
    queries: [
      "amd ryzen 5 ryzen 7 desktop processor",
      "intel core i5 i7 i9 14th 13th gen processor",
      "b650 b550 x670 am5 am4 gaming motherboard",
      "b760 z790 h610 lga1700 wifi motherboard",
      "asus rog tuf msi mag gigabyte aorus motherboard",
      "asrock biostar mini itx micro atx motherboard",
      "thermal grizzly noctua arctic cpu air cooler",
      "360mm 240mm argb liquid aio cpu cooler",
      "pcie riser cable vertical gpu mount",
      "argb pwm cabinet cooling fan kit",
      "wi-fi 6e pcie network card bluetooth 5.3",
      "mini pc barebone intel nuc ryzen",
    ],
  },
  {
    name: "pc cabinet psu",
    target: 250,
    queries: [
      "mid tower tempered glass gaming pc cabinet",
      "panoramic dual chamber fish tank pc case",
      "750w 850w 80 plus gold full modular psu",
      "650w 550w 80 plus bronze power supply",
      "corsair cooler master nzxt lian li cabinet",
      "ant esports zebronics deepcool msi pc case",
      "seasonic gigabyte thermaltake silverstone psu",
      "itx small form factor mini pc case",
      "sleeved psu extension cables argb",
      "gpu support bracket anti sag stand",
      "pc case dust filter magnetic mesh",
      "server rack mount chassis cabinet",
    ],
  },
  {
    name: "camera accessories",
    target: 250,
    queries: [
      "3 axis smartphone dslr gimbal stabilizer",
      "dji osmo mobile insta360 zhiyun feiyutech gimbal",
      "wireless Lavalier collar microphone 2tx 1rx",
      "dji mic rode boya digitek hollyland wireless mic",
      "carbon fiber aluminum camera tripod monopod",
      "18 inch led ring light with tripod stand",
      "godox cob studio video continuous light softbox",
      "camera lens 50mm 35mm 85mm canon sony nikon",
      "nd polarizer camera lens filter uv",
      "dry cabinet electronic dehumidifier lens storage",
      "action camera chest head mount accessory kit",
      "teleprompter portable ipad camera studio",
    ],
  },
  {
    name: "car audio",
    target: 250,
    queries: [
      "9 inch 10 inch android car stereo player",
      "underseat active car subwoofer amplifier",
      "component coaxial car door speakers",
      "pioneer sony jbl infinity alpine car audio",
      "blaupunkt nakamichi hypersonic onkyo car stereo",
      "4 channel monoblock car amplifier",
      "360 bird view car camera system",
      "car ambient interior led strip lighting",
      "car headrest android monitor screen",
      "damping sheet sound deadening car door",
      "obd2 scanner car diagnostic tool",
      "wireless carplay adapter dongle",
    ],
  },
  {
    name: "home inverter",
    target: 250,
    queries: [
      "150ah 200ah tall tubular inverter battery",
      "luminous exide amaron livguard microtek inverter",
      "hybrid solar inverter mppt 2kva 3kva 5kva",
      "lithium lifepo4 inverter battery pack",
      "solar panel 100w 200w 550w monocrystalline",
      "double battery inverter trolley cabinet",
      "4kva 5kva mainline voltage stabilizer home",
      "ac voltage stabilizer 1.5 ton 2 ton copper",
      "portable camping power station 500w 1000w",
      "digital energy meter submeter single phase",
      "rccb mcb distribution box changeover switch",
      "heavy duty 50m cable reel extension",
    ],
  },

  // ── 12 New High-Volume Categories (+22,000 New Products + 1,000 Vacuum Cleaner Boost = +23,000) ──
  {
    name: "office bags",
    target: 2000,
    queries: [
      "office bag for men laptop",
      "office bag for women tote laptop",
      "leather laptop messenger bag men",
      "executive briefcase bag office",
      "work tote bag women 15.6 inch laptop",
      "waterproof laptop office bag sling",
      "genuine leather office bag men",
      "professional laptop handbag women office",
      "slim laptop shoulder bag office",
      "business travel briefcase laptop bag",
      "mens office side bag messenger",
      "womens formal office handbag tote",
      "laptop portfolio sleeve case office",
      "expandable office laptop bag men",
      "vegan leather laptop tote bag women",
      "canvas messenger office bag laptop",
      "14 inch laptop office bag",
      "16 inch laptop office briefcase",
      "office backpack laptop formal men",
      "office backpack women stylish laptop",
      "mokobara office laptop bag",
      "wildcraft office laptop bag",
      "safari uppercase office laptop bag",
      "hidesign da milano leather office bag",
      "tommy hilfiger allen solly office bag",
      "van heusen louis philippe office bag",
      "zouk miraggio women office tote bag",
      "lavie caprese baggit office bag women",
      "arctic hunter fur jaden office laptop bag",
      "assembly dailyobjects office laptop bag",
      "document file organizer office bag",
      "convertible backpack briefcase office bag",
    ],
  },
  {
    name: "decor items",
    target: 2500,
    queries: [
      "home decor showpiece living room",
      "decorative flower vase ceramic modern",
      "table decor figurines sculpture aesthetic",
      "living room center table decor items",
      "brass idol statue home decor antique",
      "nordic ceramic donut vase home decor",
      "candle holder tea light stand decorative",
      "decorative glass bowl platter centerpiece",
      "aesthetic room decor items bedroom",
      "indoor tabletop water fountain home decor",
      "decorative wooden tray accent decor",
      "metal abstract sculpture showpiece living room",
      "boho home decor items macrame basket",
      "crystal lotus feng shui decor showpiece",
      "decorative table clock vintage antique",
      "resin deer horse elephant showpiece decor",
      "glass terrarium planter tabletop decor",
      "dried pampas grass artificial flowers vase",
      "decorative lantern moroccan lamp home",
      "miniature bonsai artificial plant pot decor",
      "ceramic table planter indoor pot stand",
      "luxury gold showpiece home decor modern",
      "wooden bookends shelf decor accents",
      "decorative mirror tray perfume vanity",
      "diwali festive urli bowl floating candle",
      "handcrafted terracotta clay home decor",
      "glass figurine hourglass sand timer decor",
      "aromatic reed diffuser scented candle decor",
      "shelf decor aesthetic minimalist objects",
      "couple abstract resin statue showpiece",
      "marble decorative coaster trinket box",
      "hanging wind chime dream catcher decor",
      "entryway console table decor items",
      "office desk decor showpiece motivational",
    ],
  },
  {
    name: "iot smart home",
    target: 1500,
    queries: [
      "smart wifi plug 16a energy monitoring",
      "smart wifi touch switch board alexa",
      "smart rgb led bulb wifi alexa google",
      "smart wifi ir blaster universal remote",
      "smart motion sensor zigbee wifi home",
      "smart door window sensor security wifi",
      "smart home automation hub zigbee matter",
      "smart curtain motor automatic wifi",
      "smart wifi led strip lights music sync",
      "smart temperature humidity sensor display",
      "smart relay switch module retrofit",
      "smart video door bell intercom wifi",
      "smart water level controller wifi iot",
      "smart socket extension board wifi",
      "smart ceiling batten tube light wifi",
      "wipro smart home wifi plug bulb",
      "tp link tapo smart plug bulb sensor",
      "philips wiz smart wifi light bulb",
      "qubo smart home plug sensor camera",
      "sonoff tuya smart wifi switch relay",
      "esp32 wifi bluetooth iot development board",
      "arduino uno mega iot starter kit sensors",
      "raspberry pi 5 4 single board computer kit",
      "nodemcu esp8266 iot relay sensor module",
      "smart fingerprint cabinet padlock bluetooth",
      "smart air quality monitor pm2.5 co2",
      "smart pet feeder wifi camera app",
      "smart irrigation timer garden wifi",
      "smart dimmer switch fan regulator wifi",
      "echo dot smart speaker alexa smart home",
      "smart smoke gas leak detector alarm wifi",
      "smart bedside ambient lamp wifi app",
    ],
  },
  {
    name: "mechanical tools",
    target: 2000,
    queries: [
      "socket wrench set ratchet tool kit",
      "combination spanner set chrome vanadium",
      "mechanic tool kit box car bike repair",
      "precision screwdriver set magnetic bits",
      "pliers wire cutter nose plier set",
      "adjustable wrench spanner heavy duty",
      "torque wrench automotive mechanic tool",
      "allen key hex key set metric imperial",
      "taparia hand tools spanner plier set",
      "stanley hand tool kit mechanic set",
      "bosch hand tool kit box home repair",
      "eastman pye venus spanner tool kit",
      "ingco total hand tool set mechanic",
      "digital vernier caliper micrometer gauge",
      "hydraulic bottle floor jack car repair",
      "heavy duty tool box organizer steel",
      "pipe wrench plumbing monkey wrench",
      "claw hammer mallet sledge hammer tool",
      "hand saw hacksaw wood metal cutting",
      "bench vice c clamp bar clamp carpentry",
      "rivet gun pop riveter blind tool kit",
      "bearing puller gear puller automotive",
      "circlip plier snap ring plier set",
      "spirit level measuring tape steel ruler",
      "wire stripper crimping tool electrical",
      "file rasp chisel set woodworking metal",
      "grease gun oil can lubrication tool",
      "tire lever lug wrench wheel spanner",
      "multimeter clamp meter digital tester",
      "stud finder metal detector wall scanner",
      "staple gun heavy duty upholstery nailer",
      "complete home repair hand tool kit 100 pcs",
    ],
  },
  {
    name: "drill machine",
    target: 1200,
    queries: [
      "impact drill machine 13mm concrete wall",
      "cordless drill driver 12v 18v 20v lithium",
      "rotary hammer drill machine sds plus",
      "electric drill machine kit home wall",
      "cordless screwdriver electric drill mini",
      "bosch impact drill machine gsb kit",
      "black decker drill machine kit home",
      "stanley cordless impact drill machine",
      "dewalt cordless brushless drill driver",
      "makita electric hammer drill machine",
      "ibell impact drill machine tool kit",
      "ingco cordless drill machine 20v",
      "cheetah dongcheng drill machine 10mm 13mm",
      "krost foster drill machine kit home",
      "heavy duty 26mm rotary hammer drill",
      "brushless cordless hammer drill battery",
      "electric drill machine 10mm wood metal",
      "mini pcb hand drill rotary tool dremel",
      "bench drill press stand pillar machine",
      "demolition breaker hammer drill machine",
      "hss masonry wood drill bit set box",
      "hole saw cutter drill bit kit wood metal",
      "impact wrench cordless electric 1/2 inch",
      "angle drill right angle attachment adapter",
      "variable speed reversible drill machine",
      "magnetic core drill machine industrial",
      "cordless combi drill 2 battery charger",
      "drill machine with 100 pcs accessories kit",
    ],
  },
  {
    name: "vacuum bots",
    target: 800,
    queries: [
      "robotic vacuum cleaner and mop lidar",
      "robot vacuum cleaner automatic floor",
      "self emptying robot vacuum cleaner",
      "dreame robotic vacuum cleaner mop",
      "ecovacs deebot robot vacuum cleaner",
      "roborock robotic vacuum cleaner mop",
      "ilife robotic vacuum cleaner home",
      "eureka forbes robotic vacuum cleaner",
      "xiaomi mi robot vacuum mop pro",
      "irobot roomba robotic vacuum cleaner",
      "narwal freo robot vacuum and mop",
      "agaro alpha robotic vacuum cleaner",
      "haier robotic vacuum cleaner mop",
      "tp link tapo robot vacuum cleaner",
      "milagrow robotic vacuum cleaner floor",
      "viomi robot vacuum cleaner lidar",
      "smart wifi alexa robot vacuum cleaner",
      "auto dust collection robot vacuum mop",
      "robotic window cleaner glass cleaning bot",
      "robotic vacuum cleaner replacement mop pad brush",
      "robot vacuum hepa filter side brush kit",
      "automatic smart floor sweeping robot",
      "pet hair robotic vacuum cleaner tangle free",
      "slim robotic vacuum cleaner under furniture",
    ],
  },
  {
    name: "tshirts",
    target: 2500,
    queries: [
      "men cotton round neck t shirt",
      "men polo collar t shirt cotton",
      "men oversized drop shoulder t shirt",
      "men graphic printed t shirt streetwear",
      "men gym sports dry fit t shirt",
      "men full sleeve cotton t shirt",
      "men henley neck t shirt casual",
      "men pack of 3 5 cotton t shirts",
      "women cotton round neck t shirt",
      "women oversized baggy graphic t shirt",
      "women polo collar t shirt casual",
      "women gym activewear sports t shirt",
      "women crop t shirt cotton summer",
      "women full sleeve cotton t shirt",
      "us polo assn men t shirt",
      "allen solly van heusen men polo t shirt",
      "levis jack jones pepe jeans men t shirt",
      "puma adidas nike reebok men t shirt",
      "the souled store bewakoof oversized t shirt",
      "damensch xyxx jockey men cotton t shirt",
      "max marks spencer women t shirt",
      "vero moda only levis women t shirt",
      "men v neck solid cotton t shirt",
      "men striped colorblock polo t shirt",
      "men waffle knit textured t shirt",
      "men heavyweight 240gsm oversized t shirt",
      "men compression quick dry running t shirt",
      "women tie dye floral printed t shirt",
      "women ribbed fitted basic t shirt",
      "unisex anime printed oversized t shirt",
      "men linen blend summer t shirt",
      "men raglan sleeve baseball t shirt",
      "kids boys girls cotton t shirt pack",
      "men collared zipper polo t shirt",
    ],
  },
  {
    name: "jeans",
    target: 2000,
    queries: [
      "men slim fit stretch denim jeans",
      "men regular straight fit jeans",
      "men relaxed baggy loose fit jeans",
      "men tapered carrot fit jeans",
      "men black skinny stretch jeans",
      "men light blue washed denim jeans",
      "men cargo denim jeans pockets",
      "men distressed ripped denim jeans",
      "women high waist wide leg jeans",
      "women straight fit mom jeans",
      "women skinny stretch denim jeans",
      "women flared bootcut denim jeans",
      "women baggy boyfriend loose jeans",
      "women black high rise denim jeans",
      "levis men jeans 511 512 501",
      "pepe jeans wrangler men denim jeans",
      "spykar mufti killer men jeans",
      "jack jones flying machine men jeans",
      "benetton lee allen solly men jeans",
      "levis women high rise jeans",
      "only vero moda women denim jeans",
      "kraus madame kotty women jeans",
      "miss chase forever 21 women jeans",
      "men selvedge raw dark indigo jeans",
      "men grey charcoal stretch jeans",
      "men athletic fit big thigh jeans",
      "women ankle length cropped jeans",
      "women jeggings denim stretch pants",
      "men pleated relaxed vintage jeans",
      "women paperbag waist denim jeans",
      "men mid rise comfort stretch jeans",
      "women cargo pockets wide leg jeans",
    ],
  },
  {
    name: "dresses",
    target: 2500,
    queries: [
      "women maxi long floral dress",
      "women midi a line casual dress",
      "women bodycon party cocktail dress",
      "women fit and flare skater dress",
      "women cotton summer sundress",
      "women wrap v neck midi dress",
      "women shirt dress belted knee length",
      "women mini short party wear dress",
      "women evening gown formal long dress",
      "women tiered ruffled boho maxi dress",
      "women satin slip evening dress",
      "women denim pinafore dungaree dress",
      "women winter knit sweater dress",
      "women ethnic fusion anarkali maxi dress",
      "women office formal sheath pencil dress",
      "women georgette pleated chiffon dress",
      "women puff sleeve square neck dress",
      "women off shoulder halter beach dress",
      "women sequin shimmer night party dress",
      "women linen breathable summer dress",
      "vero moda women western dress",
      "only mango forever 21 women dress",
      "harpa miss chase faballey women dress",
      "marks spencer allen solly women dress",
      "biba w aurelia women ethnic dress",
      "berrylush aahwan tokyo talkies dress",
      "kazo madame rare women party dress",
      "women maternity nursing feeding dress",
      "women black little black dress lbd",
      "women white eyelet lace beach dress",
      "women polka dot vintage retro dress",
      "women corset bustier midi dress",
      "women velvet winter party dress",
      "women kaftan resort wear maxi dress",
    ],
  },
  {
    name: "shirts & tops",
    target: 2000,
    queries: [
      "men formal cotton slim fit shirt",
      "men casual checkered plaid shirt",
      "men pure linen solid summer shirt",
      "men denim button down shirt",
      "men oxford button down casual shirt",
      "men floral tropical beach resort shirt",
      "men mandarin chinese collar shirt",
      "men overshirt shacket corduroy flannel",
      "men satin party wear printed shirt",
      "allen solly van heusen men formal shirt",
      "louis philippe peter england men shirt",
      "arrow raymond park avenue men shirt",
      "us polo assn levis men casual shirt",
      "women casual printed cotton top",
      "women formal office blouse shirt",
      "women peplum waist stylish top",
      "women crop top western party wear",
      "women chiffon georgette ruffle top",
      "women tunic long top for jeans",
      "women satin halter cowl neck top",
      "women ribbed tank camisole top",
      "women oversized cotton shirt",
      "women lace embroidered boho top",
      "women off shoulder cold shoulder top",
      "vero moda only women tops",
      "allen solly van heusen women formal top",
      "harpa miss chase tokyo talkies women top",
      "marks spencer mango women shirt top",
      "men textured popcorn knit resort shirt",
      "men cuban camp collar half sleeve shirt",
      "women wrap tie front blouse top",
      "women knit polo collared top",
    ],
  },
  {
    name: "hoodies & jackets",
    target: 1500,
    queries: [
      "men fleece pullover hoodie sweatshirt",
      "men zipper hooded sweatshirt jacket",
      "men bomber flight casual jacket",
      "men winter puffer quilted jacket",
      "men blue black denim trucker jacket",
      "men faux leather biker jacket",
      "men waterproof windcheater rain jacket",
      "men varsity college baseball jacket",
      "men wool blend winter sweater pullover",
      "men sleeveless quilted nehru puffer vest",
      "women oversized fleece hoodie sweatshirt",
      "women winter puffer parka trench coat",
      "women denim cropped trucker jacket",
      "women faux leather moto biker jacket",
      "women woollen cardigan shrug sweater",
      "women formal office blazer coat",
      "men slim fit casual formal blazer",
      "puma adidas nike men hoodie jacket",
      "allen solly us polo men winter jacket",
      "woodland monte carlo men sweater jacket",
      "levis jack jones men denim jacket",
      "fort collins campus sutra men jacket",
      "vero moda only women winter jacket",
      "marks spencer madame women cardigan sweater",
      "men thermal fleece lined zip jacket",
      "women fleece sherpa teddy jacket",
      "unisex graphic printed streetwear hoodie",
      "men corduroy trucker collar jacket",
    ],
  },
  {
    name: "trousers & trackpants",
    target: 1500,
    queries: [
      "men slim fit cotton chinos trousers",
      "men formal pleated office trousers",
      "men multi pocket cargo pants cotton",
      "men cotton joggers cuffed track pants",
      "men gym running sports track pants",
      "men linen relaxed drawstring trousers",
      "men corduroy straight casual pants",
      "men athletic shorts gym running shorts",
      "women high waist wide leg formal trousers",
      "women korean pleated tailored pants",
      "women cargo parachute utility pants",
      "women cotton joggers lounge track pants",
      "women high waist gym yoga leggings",
      "women flared palazzo wide leg pants",
      "women cigarette ankle length formal pants",
      "allen solly van heusen men formal trousers",
      "peter england louis philippe men chinos",
      "arrow raymond park avenue men trousers",
      "puma adidas nike men track pants joggers",
      "jockey boldfit hrX men gym track pants",
      "levis us polo assn men chinos",
      "vero moda only women formal trousers",
      "marks spencer allen solly women trousers",
      "blissclub puma adidas women yoga leggings",
      "men baggy pleated relaxed trousers",
      "men waterproof trekking hiking pants",
      "women linen summer wide leg trousers",
      "men stretchable formal office pants",
    ],
  },

  // ── 25 New High-Volume Categories (+50,000 Unique Products) ───────────────
  {
    name: "sarees",
    target: 2500,
    queries: [
      "banarasi silk saree for women wedding",
      "kanjivaram pure silk saree traditional",
      "cotton printed daily wear saree women",
      "georgette party wear sequin saree",
      "organza floral embroidered saree women",
      "chiffon lightweight casual saree",
      "linen handloom zari border saree",
      "bandhani rajasthani print saree",
      "patola silk festive saree women",
      "chanderi silk cotton festive saree",
      "paithani maharashtrian silk saree",
      "mysore crepe silk saree women",
      "tussar bhagalpuri silk saree",
      "sambalpuri handloom cotton saree",
      "kota doria lightweight summer saree",
      "tant bengali cotton handloom saree",
      "maheshwari silk cotton saree",
      "kora organza tissue silk saree",
      "net embroidered bridal reception saree",
      "satin silk solid plain party saree",
      "ready to wear pre draped pleated saree",
      "velvet border winter wedding saree",
      "kalamkari printed cotton silk saree",
      "pochampally ikat handloom saree",
      "mirror work navratri festive saree",
      "black sequin cocktail party saree",
      "red bridal zari work wedding saree",
      "pastel floral summer organza saree",
      "banarasi soft lichi silk saree",
      "chikankari lucknowi georgette saree",
      "saree with unstitched designer blouse",
      "siril mirchi fashion women saree",
      "anand sarees akhilam women silk saree",
      "mimosa kanchipuram silk saree women",
    ],
  },
  {
    name: "kurtis & kurta sets",
    target: 2500,
    queries: [
      "women cotton straight kurti daily wear",
      "women anarkali flared kurta set dupatta",
      "women embroidered kurta palazzo set",
      "women chikankari lucknowi rayon kurti",
      "women festive silk kurta pant dupatta set",
      "women short kurti top for jeans cotton",
      "women a line printed office wear kurti",
      "women sharara kurta dupatta wedding set",
      "women bandhani printed jaipuri kurta set",
      "women alia cut flared anarkali kurta",
      "women nyra cut embroidered kurta set",
      "women velvet winter embroidered kurta set",
      "women woolen winter warm kurti set",
      "women chanderi silk festive kurta set",
      "women muslin silk printed kurta pant set",
      "women georgette sequence party kurta set",
      "women kaftan style printed cotton kurti",
      "women feeding maternity nursing kurti",
      "women sleeveless summer cotton kurti",
      "women collar neck formal office kurti",
      "biba women cotton kurta set",
      "w for woman straight printed kurta",
      "aurelia women festive kurta set",
      "libas women embroidered kurta pant set",
      "janasya women cotton anarkali kurta",
      "indo era women silk blend kurta set",
      "gosriki women cotton blend kurta set",
      "rangita women printed rayon kurti",
      "anouk sangria women ethnic kurta set",
      "varanga vbuyz women festive kurta set",
      "women pakistani style heavy kurta set",
      "women mirror work navratri kurti",
      "women indigo block print cotton kurti",
      "women white embroidered chikankari kurti",
    ],
  },
  {
    name: "womens footwear",
    target: 2500,
    queries: [
      "women block heels party wear sandals",
      "women wedges platform comfortable sandals",
      "women flat casual daily wear sandals",
      "women ethnic jutti mojari embroidered",
      "women kolhapuri chappal flat leather",
      "women ballerina belly formal office shoes",
      "women loafers moccasins slip on shoes",
      "women white casual fashion sneakers",
      "women lightweight walking running shoes",
      "women stiletto pointed toe party heels",
      "women kitten low heel formal sandals",
      "women orthopedic soft doctor slippers",
      "women waterproof flip flops sliders",
      "women ankle chelsea leather boots",
      "women mules backless formal flats",
      "women bridal golden silver wedge heels",
      "women gladiator strappy summer sandals",
      "women chunky platform dad sneakers",
      "metro women heels sandals flats",
      "mochi women ethnic party sandals",
      "bata women formal bellies sandals",
      "catwalk inc 5 women stylish heels",
      "marc loire shoetopia women heels flats",
      "skechers women walking memory foam shoes",
      "puma adidas women casual sneakers",
      "campus sparx asian women sports shoes",
      "crocs women clogs waterproof sandals",
      "clarks hush puppies women comfort shoes",
      "allen solly van heusen women heels",
      "street style store women boots heels",
      "women transparent clear strap heels",
      "women memory foam ortho house slippers",
      "women winter fur lined warm boots",
      "women canvas lace up casual sneakers",
    ],
  },
  {
    name: "mens footwear",
    target: 2500,
    queries: [
      "men casual chunky white sneakers",
      "men suede leather driving loafers",
      "men penny tassel slip on loafers",
      "men leather formal derby oxford shoes",
      "men monk strap formal leather shoes",
      "men chelsea suede ankle leather boots",
      "men high top lace up street sneakers",
      "men trekking hiking waterproof boots",
      "men leather casual sandals floaters",
      "men sports velcro outdoor sandals",
      "men orthopedic soft cushion slippers",
      "men athletic pool flip flops sliders",
      "men waterproof garden clogs sandals",
      "men ethnic wedding jutti mojari",
      "men canvas lace up casual shoes",
      "men boat deck casual leather shoes",
      "men steel toe industrial safety shoes",
      "men badminton non marking court shoes",
      "men football turf studs cleats shoes",
      "men cricket rubber spikes sports shoes",
      "woodland men leather boots sandals",
      "red tape men sneakers formal shoes",
      "bata hush puppies men formal leather shoes",
      "clarks lee cooper men leather boots",
      "sparx campus asian men sandals sneakers",
      "puma adidas reebok men casual sneakers",
      "skechers men slip in walking shoes",
      "us polo assn men casual sneakers loafers",
      "louis stitch ruosh men leather shoes",
      "crocs birkenstock men clogs sliders",
      "neeman bacca bucci men sneakers boots",
      "liberty centellino men formal casual shoes",
      "men memory foam slip on walking shoes",
      "men breathable mesh gym training shoes",
    ],
  },
  {
    name: "handbags & wallets",
    target: 2500,
    queries: [
      "women stylish sling crossbody bag",
      "women large tote shopper handbag",
      "women bridal clutch evening party purse",
      "women ethnic embroidered potli bag",
      "women zip around leather wallet purse",
      "women satchel structured shoulder bag",
      "women hobo soft slouchy handbag",
      "women mini backpack stylish casual",
      "women bucket drawstring shoulder bag",
      "women quilted chain strap sling bag",
      "women combo set of 3 handbags",
      "women makeup cosmetic travel pouch bag",
      "men genuine leather bi fold wallet",
      "men rfid blocking slim leather wallet",
      "men pop up metal card holder wallet",
      "men zip around clutch travel wallet",
      "men leather passport holder organizer",
      "men waist fanny pack chest sling bag",
      "lavie women handbag sling wallet",
      "caprese women tote satchel handbag",
      "baggit women cruelty free handbag",
      "zouk women vegan leather tote sling bag",
      "miraggio women stylish shoulder handbag",
      "lino perros women clutch tote handbag",
      "exotic mammon women handbag combo",
      "wildhorn urban forest men leather wallet",
      "tommy hilfiger titan men leather wallet",
      "hide & skin contacts men leather wallet",
      "da milano hidesign women leather wallet",
      "fossil guess aldo women sling wallet",
      "dailyobjects women tote pouch wallet",
      "fastrack allen solly women sling bag",
      "van heusen peter england men wallet",
      "women jute canvas printed tote bag",
    ],
  },
  {
    name: "kids clothing",
    target: 2500,
    queries: [
      "boys cotton printed t shirt pack",
      "boys casual denim jeans pants",
      "boys formal party blazer suit set",
      "boys ethnic silk kurta pyjama set",
      "boys cotton shorts joggers pack",
      "boys winter puffer jacket hoodie",
      "boys casual checked cotton shirt",
      "boys night suit pajama cotton set",
      "girls party wear net frock dress",
      "girls cotton summer casual frock dress",
      "girls ethnic lehenga choli festive set",
      "girls kurta palazzo ethnic set",
      "girls t shirt leggings coord set",
      "girls denim jeans jeggings pants",
      "girls winter cardigan sweater jacket",
      "girls cotton night suit pajama set",
      "baby boy newborn cotton romper onesie",
      "baby girl newborn frock gift clothing set",
      "toddler kids woolen thermal innerwear",
      "kids waterproof rain coat poncho",
      "hopscotch boys girls party dress set",
      "allen solly junior boys shirts t shirts",
      "us polo assn kids boys polo jeans",
      "max kids boys girls cotton clothing",
      "marks spencer kids dresses t shirts",
      "gini and jony kids denim jackets",
      "pantaloons junior kids ethnic casual",
      "babyhug firstcry kids cotton clothing",
      "cutecumber girls party gown dress",
      "tiber taber boys girls ethnic kurta",
      "kids school uniform sweater trousers",
      "kids swimming costume swimwear set",
      "boys sports jersey football cricket set",
      "girls tutu ballet skirt top set",
    ],
  },
  {
    name: "mobile accessories",
    target: 2500,
    queries: [
      "iphone 16 15 magsafe back cover case",
      "samsung galaxy s24 s25 back cover case",
      "oneplus 12 13 nord shockproof back cover",
      "redmi note realme transparent armor case",
      "tempered glass screen protector privacy",
      "camera lens protector metal ring iphone",
      "gan 65w 45w 33w fast wall charger adapter",
      "20w pd type c fast charger iphone",
      "braided usb c to c 100w fast cable",
      "mfi certified lightning cable iphone",
      "3 in 1 magnetic wireless charging stand",
      "car dashboard magnetic mobile holder mount",
      "adjustable aluminum desktop phone stand",
      "bluetooth selfie stick tripod with light",
      "mobile gaming cooling fan semiconductor",
      "gaming finger sleeves trigger controller",
      "usb c otg adapter card reader mobile",
      "waterproof mobile pouch underwater cover",
      "phone lanyard crossbody neck strap",
      "magsafe magnetic wallet card holder",
      "spigen phone back cover tempered glass",
      "ringke esr iphone samsung magsafe case",
      "dailyobjects designer phone cover case",
      "anker belkin fast charger cable mobile",
      "stuffcool ambrane portronics charger cable",
      "boat duracell braided charging cable",
      "apple original adapter cable accessory",
      "samsung 25w 45w original travel adapter",
      "car fast charger dual port 65w pd",
      "phone grip pop socket ring holder",
      "cleaning kit mobile earbuds screen spray",
      "smartwatch silicone leather metal strap",
      "airpods earbuds silicone protective case",
      "ipad tablet folio keyboard flip cover",
    ],
  },
  {
    name: "kitchen storage & containers",
    target: 2500,
    queries: [
      "airtight kitchen storage containers set plastic",
      "borosilicate glass storage jars bamboo lid",
      "stainless steel masala dabba spice box",
      "insulated stainless steel lunch box tiffin",
      "electric heated tiffin lunch box office",
      "thermosteel vacuum insulated water bottle 1l",
      "copper water bottle hammered 1 litre",
      "glass oil dispenser bottle leakproof",
      "fridge storage organizer boxes vegetables",
      "stainless steel dish drying rack kitchen",
      "modular kitchen storage trolley 4 tier",
      "grain rice flour storage drum container",
      "rotating spice rack carousel 16 jar",
      "magnetic fridge side organizer rack",
      "under sink expandable storage rack",
      "bread box wooden metal kitchen counter",
      "tea coffee sugar canister jar set",
      "silicone collapsible food storage container",
      "milton insulated tiffin bottle casserole",
      "cello airtight containers water bottle",
      "borosil glass lunch box storage jars",
      "signoraware modular plastic lunch container",
      "tupperware airtight kitchen container bottle",
      "nayasa femora kitchen storage container",
      "lock and lock airtight glass container",
      "solimo amazon basics kitchen jars",
      "insulated travel coffee tumbler mug sipper",
      "kids leakproof bento lunch box bottle",
      "dry fruit serving tray airtight box",
      "stainless steel milk can oil dispenser",
      "pickle ceramic barni jar set",
      "pantry pull out basket kitchen organizer",
      "cutlery holder spoon stand countertop",
      "fruit vegetable mesh basket stand",
    ],
  },
  {
    name: "books & novels",
    target: 2000,
    queries: [
      "bestseller self help personal development book",
      "fiction mystery thriller crime novel paperback",
      "contemporary romance love story novel book",
      "indian author fiction novel bestseller",
      "personal finance investing stock market book",
      "business startup entrepreneurship management book",
      "biography autobiography memoir hardcover book",
      "science fiction fantasy epic novel trilogy",
      "classic world literature paperback box set",
      "psychology philosophy human behavior book",
      "indian history mythology non fiction book",
      "upsc civil services ias preparation books",
      "jee main advanced physics chemistry math book",
      "neet ug biology medical entrance book",
      "cat gmat gre quantitative aptitude book",
      "ssc banking railway competitive exam book",
      "programming python java system design book",
      "children illustrated story books box set",
      "kids encyclopedia general knowledge atlas",
      "manga anime comic book box set",
      "graphic novel comic book hardcover",
      "hindi literature upanyas novel books",
      "spiritual meditation bhagavad gita book",
      "indian cooking baking recipe cookbook",
      "health nutrition fitness diet book",
      "parenting child psychology guide book",
      "english grammar vocabulary spoken book",
      "poetry collection hardcover gift book",
      "penguin random house bestseller fiction",
      "harpercollins bloomsbury paperback novel",
    ],
  },
  {
    name: "kitchen tools & gadgets",
    target: 2000,
    queries: [
      "stainless steel chef knife set with block",
      "wooden bamboo teak chopping cutting board",
      "vegetable chopper manual pull string cutter",
      "stainless steel mandoline slicer grater",
      "silicone cooking spatula ladle utensil set",
      "wooden marble chakla belan rolling pin",
      "heavy duty mortar pestle imamdasta okhli",
      "stainless steel mixing bowls nesting set",
      "digital kitchen food weighing scale grams",
      "stainless steel oil strainer colander mesh",
      "garlic press ginger crusher kitchen tool",
      "measuring cups spoons stainless steel set",
      "non stick cake baking tin mould set",
      "silicone baking mat oven gloves mitts",
      "electric milk frother egg beater whisk",
      "pizza cutter wheel kitchen scissors shears",
      "manual citrus lemon juicer squeezer",
      "ice cream scoop potato masher stainless",
      "tea infuser strainer mesh ball stainless",
      "oil brush silicone basting pastry set",
      "prestige pigeon kitchen tools knife set",
      "victorinox bergner chef knife kitchen",
      "ganesh solimo vegetable chopper slicer",
      "borosil meyer kitchen bakeware tools",
      "kitchen sink strainer drain basket",
      "gas lighter stainless steel rechargeable",
      "apron cotton kitchen waterproof pockets",
      "roti basket wooden casserole cloth",
      "stainless steel tongs pakkad chimta",
      "butter dish cheese grater kitchen gadget",
    ],
  },
  {
    name: "home organization & storage",
    target: 2000,
    queries: [
      "wardrobe clothes organizer foldable storage",
      "underbed blanket saree storage bag zipper",
      "foldable laundry basket hamper with lid",
      "non slip velvet wooden clothes hangers set",
      "modular plastic drawer chest storage unit",
      "acrylic makeup cosmetic vanity organizer",
      "vacuum compression storage bags clothes",
      "stackable clear plastic storage boxes lid",
      "over the door hanging coat towel hooks",
      "rolling 3 tier metal utility storage cart",
      "jewellery organizer box velvet travel case",
      "watch box organizer glass top 12 slots",
      "sunglasses eyewear organizer display tray",
      "saree cover organizer non woven set",
      "bra underwear socks drawer divider box",
      "toy storage organizer bins rack kids",
      "wall mounted broom mop holder rack",
      "stainless steel foldable cloth drying stand",
      "ironing board foldable heavy duty stand",
      "dustbin pedal sensor trash can home",
      "house of quirk storage organizer bag",
      "kuber industries saree wardrobe organizer",
      "cello nilkamal plastic storage cabinet",
      "urban space laundry basket organizer",
      "bamboo woven storage basket hamper",
      "cable wire management organizer box",
      "medicine first aid storage organizer box",
      "shoe box clear magnetic stackable",
      "remote control desk caddy organizer",
      "hanging closet shelf 6 tier fabric",
    ],
  },
  {
    name: "bedding & pillows",
    target: 2000,
    queries: [
      "orthopedic memory foam cervical pillow",
      "microfiber soft sleeping pillows set of 2",
      "contour neck pain relief gel pillow",
      "cotton velvet decorative cushion covers 16x16",
      "microfiber cushion fillers inserts set of 5",
      "cotton reversible ac dohar double bed",
      "all season microfiber comforter quilt double",
      "heavy winter woollen mink blanket double",
      "knitted cotton sofa throw blanket boho",
      "waterproof terry cotton mattress protector",
      "satin silk anti frizz pillowcase cover",
      "memory foam travel neck pillow airplane",
      "full body maternity pregnancy u pillow",
      "wedge acid reflux elevation pillow foam",
      "cotton bolster cylinder pillow with cover",
      "velvet quilted sofa slipcover protector",
      "cotton diwan set 8 pieces living room",
      "fitted elastic mattress topper king queen",
      "wakefit sleepyhead memory foam pillow",
      "recron certified microfiber pillow set",
      "story@home cortina cushion covers comforter",
      "spaces bombay dyeing dohar blanket",
      "trident swayam cotton bedding cushion",
      "haus kinder divine casa comforter set",
      "cooling bamboo shredded memory foam pillow",
      "floor meditation large square seating cushion",
      "kids bolster pillow cartoon bedding set",
      "chair seat pad tie on dining cushion",
      "mosquito net foldable king size double bed",
      "weighted anxiety glass bead blanket",
    ],
  },
  {
    name: "lighting & lamps",
    target: 2000,
    queries: [
      "bedside ceramic fabric table lamp warm",
      "modern standing corner floor lamp living room",
      "rechargeable led study desk reading lamp",
      "wall sconce antique brass bedroom lamp",
      "led ceiling panel flush mount light 18w",
      "warm white fairy copper string lights",
      "motion sensor rechargeable cabinet led light",
      "3d moon crystal ball galaxy night lamp",
      "solar waterproof outdoor garden pathway lamp",
      "industrial hanging pendant cage ceiling light",
      "vintage edison filament warm led bulb",
      "rgb sunset projection ambient floor lamp",
      "emergency rechargeable inverter led bulb",
      "cob led recessed downlight spotlight ceiling",
      "mirror front vanity led bathroom wall light",
      "touch dimmable cordless restaurant table lamp",
      "bamboo rattan boho woven hanging lamp",
      "philips wipro led ceiling bulb batten",
      "syska havells orient led panel tube light",
      "homesake crosscut floor table lamp",
      "led strip light 5m waterproof rgb remote",
      "clip on book reading flexible led lamp",
      "plug in automatic twilight night bulb",
      "gate pillar outdoor waterproof glass lamp",
      "salt rock himalayan healing table lamp",
      "track light rail spotlight showroom led",
      "festival curtain waterfall led string light",
      "smart dimming led ceiling fan light",
      "kids silicone cute animal night lamp",
      "mosquito killer uv led lamp trap",
    ],
  },
  {
    name: "stationery & art supplies",
    target: 2000,
    queries: [
      "ruled unruled hardcover journal diary notebook",
      "2026 daily weekly planner organizer diary",
      "fine tip gel rollerball pens pack",
      "luxury fountain pen ink converter gift",
      "acrylic paint tubes set 24 36 shades",
      "watercolor cake tubes brush artist set",
      "oil pastel soft pastel artist drawing set",
      "stretched cotton canvas boards painting set",
      "heavyweight 300gsm watercolor sketchbook pad",
      "colored pencils 48 72 shades artist tin",
      "dual tip alcohol markers brush pen set",
      "graphite charcoal sketching pencils kit",
      "wooden tabletop tripod painting easel stand",
      "epoxy resin art starter kit moulds",
      "calligraphy dip pen nib ink set",
      "polymer air dry sculpting clay tools",
      "origami craft paper scrapbook sticker kit",
      "large vegan leather desk mat blotter",
      "wooden acrylic pen stand desk organizer",
      "scientific geometry mathematical drawing set",
      "camlin kokuyo art supplies paint sketchbook",
      "faber castell colour pencils markers",
      "brustro artist sketchbooks paints brushes",
      "staedtler micron fineliner drafting pens",
      "classmate uniball pilot pens notebooks",
      "parker cross pierre cardin gift pen",
      "solo document expanding folder file",
      "sticky notes index tabs highlighter set",
      "heavy duty stapler punch scissor office",
      "electric pencil sharpener desk vacuum",
    ],
  },
  {
    name: "makeup & cosmetics",
    target: 2000,
    queries: [
      "matte liquid transferproof lipstick women",
      "hydrating tinted lip gloss balm oil",
      "full coverage liquid foundation matte spf",
      "high coverage dark circle concealer",
      "oil control compact setting face powder",
      "shimmer matte eyeshadow palette 18 shades",
      "waterproof smudgeproof eyeliner kajal",
      "volumizing lengthening waterproof mascara",
      "cream powder cheek blush tint",
      "illuminating liquid powder face highlighter",
      "pore minimizing matte makeup primer",
      "long lasting dewy makeup setting spray",
      "contour bronzer sculpting palette",
      "eyebrow pencil pomade gel definer",
      "gel matte nail polish manicure kit",
      "micellar water cleansing balm makeup remover",
      "soft makeup brushes beauty blender sponge",
      "maybelline new york lipstick foundation mascara",
      "lakme absolute 9 to 5 makeup cosmetics",
      "loreal paris infallible foundation lipstick",
      "sugar cosmetics matte lipstick kajal blush",
      "swiss beauty eyeshadow primer concealer",
      "mars cosmetics lip liner palette",
      "colorbar faces canada foundation compact",
      "insight cosmetics concealer primer gloss",
      "renee mamaearth kay beauty makeup",
      "false eyelashes magnetic glue kit",
      "bb cc cream tinted moisturizer spf",
      "makeup vanity box organizer led mirror",
      "bridal complete makeup combo gift kit",
    ],
  },
  {
    name: "haircare & personal care",
    target: 2000,
    queries: [
      "anti hair fall sulfate free shampoo",
      "anti dandruff ketoconazole scalp shampoo",
      "keratin smoothing hydrating hair conditioner",
      "deep conditioning hair spa mask cream",
      "argan frizz control shine hair serum",
      "rosemary bhringraj onion hair growth oil",
      "heat protectant hair spray leave in cream",
      "strong hold matte hair wax clay pomade",
      "moisturizing exfoliating body wash shower gel",
      "deep nourishing shea cocoa body lotion",
      "coffee walnut exfoliating body scrub",
      "long lasting body mist deodorant spray",
      "underarm roll on aha bha brightening",
      "men beard growth oil wash balm softener",
      "electric rechargeable sonic toothbrush heads",
      "water flosser oral irrigator cordless",
      "men 5 blade safety cartridge razor kit",
      "women sensitive body hair removal razor",
      "wooden neem wide tooth detangling comb",
      "loofah bath brush silicone scalp massager",
      "loreal paris tresemme shampoo serum mask",
      "dove nivea vaseline body wash lotion",
      "mamaearth wow skin science haircare",
      "plum minimalist pilgrim haircare bodycare",
      "bare anatomy wishcare hair growth serum",
      "gillette oral b colgate grooming oral care",
      "the man company ustraa beard body care",
      "mcaffeine body scrub wash butter",
      "forest essentials kama ayurveda personal care",
      "hand foot crack repair cream manicure kit",
    ],
  },
  {
    name: "fitness & gym accessories",
    target: 2000,
    queries: [
      "heavy duty resistance bands tubes set",
      "weighted speed skipping jump rope",
      "padded gym workout gloves wrist support",
      "compression knee sleeves elbow wraps gym",
      "weightlifting leather lever powerlifting belt",
      "leakproof protein shaker bottle steel",
      "ab roller wheel core workout knee mat",
      "push up board bars home chest workout",
      "adjustable hand grip forearm strengthener",
      "cast iron neoprene kettlebell 8kg 12kg",
      "adjustable ankle wrist weights velcro",
      "high density foam roller muscle recovery",
      "gym duffle bag with shoe compartment",
      "doorway chin up pull up bar home",
      "battle rope gymnastic rings suspension trainer",
      "aerobic stepper balance board stability ball",
      "dip belt weight lifting wrist straps",
      "yoga block cork stretching strap wheel",
      "boldfit gym accessories shaker gloves bands",
      "strauss nivia gym fitness workout gear",
      "kobo aurion weightlifting belt gloves",
      "lifelong cultsport home fitness accessories",
      "badminton shuttlecock feather nylon pack",
      "tennis cricket leather practice ball",
      "basketball volleyball air pump needle",
      "athletic kinesiology sports tape",
      "massage lacrosse spiky recovery ball",
      "speed agility ladder cones training kit",
      "sweat waist trimmer sauna slimming belt",
      "smart jump rope digital counter fitness",
    ],
  },
  {
    name: "automotive bike accessories",
    target: 2000,
    queries: [
      "waterproof bike two wheeler body cover",
      "motorcycle handlebar waterproof mobile mount",
      "gel comfort motorcycle touring seat cushion",
      "bike chain lube cleaner brush maintenance kit",
      "motorcycle led fog light projector switch",
      "bike disc brake alarm anti theft lock",
      "motorcycle heavy duty bungee cargo net",
      "microfiber 800gsm car bike cleaning cloth",
      "car ceramic coating liquid wax polish",
      "high foam ph neutral car wash shampoo",
      "car dashboard solar perfume air freshener",
      "magnetic car window sunshade windshield cover",
      "car leather seat cleaner conditioner spray",
      "tubeless tyre puncture repair tool kit",
      "car trunk boot foldable storage organizer",
      "car blind spot convex side mirror",
      "car door edge guard bumper protector strip",
      "car steering wheel leather stitched cover",
      "motorcycle handlebar grip bar end mirror",
      "bike waterproof rain gear riding suit",
      "3m motul car bike care polish lube",
      "wavex turtle wax car detailing kit",
      "grandpitstop bobo bike mount puncture kit",
      "autofurnish vista car cover mat care",
      "car trash bin cup holder phone mount",
      "car scratch remover rubbing compound polish",
      "car battery trickle charger 12v smart",
      "motorcycle tank pad sticker knee grip",
      "reflective safety vest warning triangle car",
      "car key fob silicone leather cover",
    ],
  },
  {
    name: "kids toys & learning",
    target: 1500,
    queries: [
      "soft plush teddy bear animal toy kids",
      "superhero action figures playset kids",
      "fashion doll set accessories playhouse",
      "kids pretend kitchen cooking doctor playset",
      "wooden jigsaw puzzles kids 3 5 8 years",
      "montessori wooden alphabet numbers blocks",
      "musical dancing light up baby toddler toy",
      "lcd writing drawing doodle board tablet",
      "non toxic playdough slime craft clay kit",
      "family strategy card board games uno",
      "kids plastic cricket football sports kit",
      "baby floating bath toys water squirt",
      "diecast metal pull back toy cars set",
      "remote control robot dinosaur toy kids",
      "play tent house castle indoor kids",
      "funskool frank puzzles board games",
      "fisher price mattel hasbro kids toys",
      "skillmatics einstein box learning kit",
      "smartivity stem diy wooden science toy",
      "rubik cube speed cube brain teaser",
      "kids karaoke singing microphone toy",
      "wooden abacus counting math toy",
      "bubble gun automatic machine outdoor toy",
      "flash cards early learning baby toddler",
    ],
  },
  {
    name: "womens innerwear & loungewear",
    target: 1500,
    queries: [
      "women cotton printed night suit pajama set",
      "women long cotton maxi nighty gown",
      "women high impact padded sports bra",
      "women seamless t shirt everyday wirefree bra",
      "women cotton hipster bikini briefs pack",
      "women cotton spaghetti camisole slip pack",
      "women tummy tucker high waist shapewear",
      "women winter thermal innerwear top bottom",
      "women satin silk bridal robe nightwear",
      "women cotton t shirt shorts loungewear set",
      "women maternity feeding nursing bra",
      "women strapless push up lace bralette",
      "jockey women bra briefs nightwear",
      "enamor clovia women bras night suit",
      "zivame van heusen women innerwear",
      "marks spencer triumph women bras panties",
      "sweet dreams juliet women nightwear",
      "women seamless cycling anti chafing shorts",
      "women ankle no show cotton socks pack",
      "women winter fleece warm pyjama set",
      "women kimono kaftan loungewear dress",
      "women ribbed seamless workout sports bra",
      "women full coverage minimizer cotton bra",
      "women bamboo breathable panties pack",
    ],
  },
  {
    name: "mens innerwear & loungewear",
    target: 1500,
    queries: [
      "men cotton trunks boxer briefs pack",
      "men woven cotton relaxed boxer shorts",
      "men combed cotton vests undershirts pack",
      "men cotton lounge pajama pants pockets",
      "men cotton knit sleep shorts loungewear",
      "men t shirt pajama night suit set",
      "men winter thermal top bottom warmer set",
      "men athletic cushioned ankle crew socks",
      "men modal ultra soft anti roll trunks",
      "men cotton formal dress socks pack",
      "men pure cotton handkerchiefs gift box",
      "jockey men briefs trunks vests socks",
      "damensch xyxx men modal trunks boxers",
      "van heusen us polo men innerwear lounge",
      "levis pepe jeans men trunks socks",
      "marks spencer puma men innerwear socks",
      "men fleece winter warm pyjama pants",
      "men breathable mesh athletic boxer briefs",
      "men sleeveless gym muscle tank vest",
      "men no show loafer invisible socks",
      "men compression inner shorts gym",
      "men bamboo antibacterial trunks vests",
      "men checked flannel winter pajama pants",
      "men woollen winter thermal socks pack",
    ],
  },
  {
    name: "electronics cables & adapters",
    target: 1500,
    queries: [
      "hdmi 2.1 8k 4k braided display cable",
      "displayport 1.4 gaming monitor cable",
      "usb c hub multiport hdmi ethernet adapter",
      "cat6 cat7 cat8 gigabit ethernet lan cable",
      "ergonomic aluminum foldable laptop stand",
      "rgb multi fan laptop cooling pad stand",
      "waterproof padded laptop sleeve 15.6 inch",
      "spike guard surge protector extension cord",
      "3.5mm aux audio braided stereo cable",
      "bluetooth 5.3 audio transmitter receiver",
      "usb 3.0 sd microsd memory card reader",
      "hdmi to vga type c display adapter",
      "universal travel power plug adapter",
      "kvm switch hdmi splitter 4k 60hz",
      "ugreen cablecreation hdmi usb c hub",
      "amazon basics honeywell extension hdmi cable",
      "portronics zebronics laptop stand usb hub",
      "tp link belkin ethernet adapter hub",
      "usb c magnetic adapter 100w right angle",
      "optical toslink digital audio cable",
      "xlr microphone audio cable shielded",
      "laptop power adapter charger 65w type c",
      "cable sleeve zipper spiral wire organizer",
      "external usb cd dvd rw optical drive",
    ],
  },
  {
    name: "bath linen & towels",
    target: 1500,
    queries: [
      "100% cotton 500gsm 600gsm bath towel large",
      "bamboo super absorbent soft bath towel",
      "cotton hand face towel set of 6",
      "microfiber quick dry hair wrap turban",
      "luxury terry cotton bathrobe men women",
      "waterproof mould resistant shower curtain",
      "memory foam anti slip bathroom floor mat",
      "diatomite quick dry stone bath mat",
      "oversized striped cotton beach pool towel",
      "kids hooded cotton animal bath towel",
      "ceramic glass liquid soap dispenser set",
      "wall mounted toothbrush paste holder",
      "trident cotton bath hand towel set",
      "spaces bombay dyeing luxury bath towels",
      "raymond home wakefit cotton bath towel",
      "story@home solimo bath mat towel set",
      "turkish cotton waffle weave bath towel",
      "gym microfiber quick dry sweat towel",
      "guest washcloth face napkin pack 12",
      "bathrobe waffle spa unisex hotel robe",
      "bamboo slatted wooden bathroom duckboard",
      "stainless steel soap dish caddy shower",
      "cotton bath sheet jumbo extra large",
      "hotel white luxury combed cotton towel",
    ],
  },
  {
    name: "baby care & nursery",
    target: 1250,
    queries: [
      "baby diaper pants overnight absorption",
      "alcohol free 99% water baby wet wipes",
      "anti colic glass ppsu baby feeding bottle",
      "silicone baby sippy cup suction bowl set",
      "gentle tear free baby wash shampoo lotion",
      "100% organic cotton muslin swaddle wrap",
      "baby bedding mattress set mosquito net",
      "bpa free silicone baby teether rattle set",
      "baby nail clipper grooming healthcare kit",
      "felt portable diaper caddy nursery basket",
      "pampers huggies mamypoko baby diapers",
      "sebamed cetaphil himalaya baby skincare",
      "chicco luvlap mee mee baby feeding care",
      "baby hooded towel washcloth organic set",
      "reusable washable cloth baby diapers",
      "baby waterproof dry sheet changing mat",
      "baby ergonomic head shaping pillow",
      "baby nail trimmer electric safe file",
      "bottle cleaning brush rack sterilizer",
      "baby bath tub foldable with thermometer",
      "baby safety corner guards drawer locks",
      "baby wooden crib mobile hanging toy",
    ],
  },
  {
    name: "luggage & travel accessories",
    target: 1250,
    queries: [
      "travel duffle weekender bag gym overnight",
      "compression packing cubes luggage organizer",
      "hanging waterproof toiletry cosmetic bag",
      "memory foam travel neck pillow eye mask",
      "rfid blocking family passport wallet organizer",
      "tsa approved combination luggage padlock",
      "digital hanging luggage weighing scale 50kg",
      "silicone luggage bag tags airport set",
      "clear waterproof shoe pouches travel bag",
      "foldable lightweight packable daypack",
      "waist money belt hidden travel pouch",
      "electronic tech cable travel organizer pouch",
      "safari wildcraft skybags duffle travel bag",
      "mokobara uppercase assembly travel accessories",
      "house of quirk packing cubes toiletry bag",
      "expandable foldable rolling duffle suitcase",
      "garment suit carrier foldable travel bag",
      "travel silicone leakproof refillable bottles",
      "luggage protective elastic suitcase cover",
      "portable digital door lock travel safety",
      "travel pill organizer weekly medicine box",
      "inflatable footrest pillow flight travel",
    ],
  },
];

const SORT_ORDERS = [
  "relevanceblender",
  "review-rank",
  "date-desc-rank",
  "price-asc-rank",
  "price-desc-rank",
];

// Amazon.in discount refinement filters
const DISCOUNT_BUCKETS = [
  "p_n_pct-off-with-tax:2665402031", // 50% Off or more
  "p_n_pct-off-with-tax:2665403031", // 60% Off or more
  "p_n_pct-off-with-tax:2665404031", // 70% Off or more
  "p_n_pct-off-with-tax:2665401031", // 35% Off or more
];

function loadData(dataFile) {
  try {
    if (fs.existsSync(dataFile)) {
      return JSON.parse(fs.readFileSync(dataFile, "utf-8"));
    }
  } catch {}
  return { products: {}, lastRun: null, runCount: 0 };
}

function loadSkus(skuFile) {
  try {
    if (fs.existsSync(skuFile)) {
      return JSON.parse(fs.readFileSync(skuFile, "utf-8"));
    }
  } catch {}
  return { categories: {}, skus: [] };
}

function parseNum(s) {
  if (s == null) return null;
  if (typeof s === "number") return isNaN(s) ? null : s;
  const cleaned = String(s).replace(/[^\d.]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function compactRecord(record) {
  if (!record || typeof record !== "object") return record;
  const rawHist = Array.isArray(record.history) ? record.history : [];
  const prices = [];
  for (const h of rawHist) {
    const p = typeof h === "number" ? h : h?.price;
    if (p != null && p > 0 && !isNaN(p)) prices.push(p);
  }
  const compact = {
    asin: record.asin,
    title: record.title,
    mrp: record.mrp ?? null,
    currentPrice: record.currentPrice ?? null,
    averagePrice: record.averagePrice ?? null,
    medianPrice: record.medianPrice ?? null,
    minPrice: record.minPrice ?? null,
    maxPrice: record.maxPrice ?? null,
    history: prices.slice(-10),
    lastChecked: record.lastChecked ?? null,
  };
  if (record.category) compact.category = record.category;
  if (record.alertCount) compact.alertCount = record.alertCount;
  if (record.lastAlertPrice != null) compact.lastAlertPrice = record.lastAlertPrice;
  if (record.lastAlertAvgPrice != null) compact.lastAlertAvgPrice = record.lastAlertAvgPrice;
  if (record.lastAlertAt) compact.lastAlertAt = record.lastAlertAt;
  if (record.samePriceAlertCount) compact.samePriceAlertCount = record.samePriceAlertCount;
  return compact;
}

/**
 * Fast direct-HTTP query to Amazon.in `/s/query` Rush streaming API (zero browser overhead).
 */
async function fetchSearchTaskDirectHttp(task, uaIndex = 0, maxRetries = 2) {
  const url = `https://www.amazon.in/s/query?${task.qs}`;
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 14000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": ua,
          Accept: "text/html,*/*",
          "Accept-Language": "en-IN,en;q=0.9",
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: "https://www.amazon.in",
          Referer: "https://www.amazon.in/",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
        },
        body: '{"customer-action":"query"}',
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 503 || res.status === 429 || res.status === 502) {
        if (attempt < maxRetries) {
          await new Promise((r) =>
            setTimeout(r, 600 * (attempt + 1) + Math.floor(Math.random() * 500))
          );
          continue;
        }
        return [];
      }
      if (!res.ok) return [];

      const text = await res.text();
      const chunks = text.split("&&&");
      const found = [];

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i].trim();
        if (!c || !c.includes('"dispatch"')) continue;
        let arr;
        try {
          arr = JSON.parse(c);
        } catch {
          continue;
        }
        if (!Array.isArray(arr) || arr[0] !== "dispatch") continue;
        const payload = arr[2];
        if (!payload || !payload.asin || !payload.html) continue;

        const parsed = parseSearchResultHtml(payload.asin, payload.html, payload.index);
        const currentPrice =
          parseNum(parsed.csaPrice) ?? parseNum(parsed.priceText);
        if (!currentPrice || currentPrice <= 0) continue;

        const mrp = parseNum(parsed.mrpText);
        let discountPct = null;
        if (parsed.discountText) {
          const m = parsed.discountText.match(/(\d+)/);
          if (m) discountPct = parseFloat(m[1]);
        }
        if (mrp && mrp > currentPrice) {
          const calcPct = ((mrp - currentPrice) / mrp) * 100;
          if (discountPct == null || calcPct > discountPct) {
            discountPct = Math.round(calcPct * 10) / 10;
          }
        }

        if (task.minDiscountPct > 0) {
          if (discountPct == null || discountPct < task.minDiscountPct) {
            continue;
          }
        }

        found.push({
          asin: payload.asin,
          title: parsed.title || payload.asin,
          currentPrice,
          mrp,
          discountPct,
        });
      }
      return found;
    } catch {
      clearTimeout(timer);
      if (attempt < maxRetries) {
        await new Promise((r) =>
          setTimeout(r, 350 * (attempt + 1) + Math.floor(Math.random() * 350))
        );
        continue;
      }
      return [];
    }
  }
  return [];
}

async function harvestCategory(
  engine,
  cat,
  existingCategoryMap,
  globalProducts,
  usedGlobalAsins
) {
  const targetCount = cat.target || DEFAULT_TARGET_PER_CATEGORY;
  const collected = new Map();

  // Seed with any already-collected items for this category
  const existingList = existingCategoryMap[cat.name] || [];
  for (const asin of existingList) {
    const p = globalProducts[asin];
    if (p) {
      p.category = cat.name;
      collected.set(asin, p);
      usedGlobalAsins.add(asin);
    }
  }

  if (collected.size >= targetCount) {
    console.log(
      `   ⏭️  [${cat.name.padEnd(28)}] Already has ${collected.size}/${targetCount} products`
    );
    return { skus: [...collected.keys()].slice(0, targetCount), added: 0 };
  }

  const startCount = collected.size;

  // Build prioritized sub-waves with per-sub-wave stall detection so we never
  // waste hundreds of queries on exhausted pages/facets.
  const subWaves = [];

  // Priority 1: 50%+ discount facet across distinct sort orders (high yield, >=50% off)
  for (const sort of SORT_ORDERS) {
    const waveTasks = [];
    for (let pageNum = 1; pageNum <= 7; pageNum++) {
      for (const q of cat.queries) {
        waveTasks.push({
          qs: `k=${encodeURIComponent(q)}&rh=${encodeURIComponent(DISCOUNT_BUCKETS[0])}&s=${sort}&page=${pageNum}`,
          minDiscountPct: MIN_DISCOUNT_PCT,
        });
      }
    }
    subWaves.push({ label: `50%+:${sort}`, tasks: waveTasks });
  }

  // Priority 2: Unfiltered queries across sort orders (filtered for >=50% in parser)
  for (const sort of SORT_ORDERS.slice(0, 3)) {
    const waveTasks = [];
    for (let pageNum = 1; pageNum <= 7; pageNum++) {
      for (const q of cat.queries) {
        waveTasks.push({
          qs: `k=${encodeURIComponent(q)}&s=${sort}&page=${pageNum}`,
          minDiscountPct: MIN_DISCOUNT_PCT,
        });
      }
    }
    subWaves.push({ label: `all>=50%:${sort}`, tasks: waveTasks });
  }

  // Priority 3: Fallback for categories needing deeper inventory — any valid priced SKU
  for (const sort of SORT_ORDERS) {
    const waveTasks = [];
    for (let pageNum = 1; pageNum <= 7; pageNum++) {
      for (const q of cat.queries) {
        waveTasks.push({
          qs: `k=${encodeURIComponent(q)}&s=${sort}&page=${pageNum}`,
          minDiscountPct: 0,
        });
      }
    }
    subWaves.push({ label: `any:${sort}`, tasks: waveTasks });
  }

  let totalQueriesRun = 0;
  let batchCounter = 0;
  const batchConcurrency =
    engine.mode === "http" ? CONCURRENCY : PLAYWRIGHT_CONCURRENCY;

  for (const wave of subWaves) {
    if (collected.size >= targetCount) break;

    let taskIdx = 0;
    let consecutiveStallBatches = 0;
    let consecutiveZeroRawBatches = 0;

    while (collected.size < targetCount && taskIdx < wave.tasks.length) {
      const batch = wave.tasks.slice(taskIdx, taskIdx + batchConcurrency);
      taskIdx += batchConcurrency;
      totalQueriesRun += batch.length;
      batchCounter++;

      let batchItems = [];
      if (engine.mode === "http") {
        const resArr = await Promise.all(
          batch.map((t, idx) =>
            fetchSearchTaskDirectHttp(t, batchCounter * batchConcurrency + idx)
          )
        );
        batchItems = resArr.flat();
      } else {
        batchItems = await engine.page.evaluate(
          async ({ batchTasks }) => {
            const parseNumInPage = (s) => {
              if (!s) return null;
              const cleaned = String(s).replace(/[^\d.]/g, "");
              const n = parseFloat(cleaned);
              return isNaN(n) ? null : n;
            };

            const parser = new DOMParser();

            const fetchOne = async (task) => {
              try {
                const res = await fetch(`/s/query?${task.qs}`, {
                  method: "POST",
                  headers: {
                    Accept: "text/html,*/*",
                    "Content-Type": "application/json",
                    "X-Requested-With": "XMLHttpRequest",
                  },
                  body: JSON.stringify({ "customer-action": "query" }),
                  credentials: "include",
                });
                if (!res.ok) return [];
                const text = await res.text();
                const chunks = text.split("&&&");
                const found = [];

                for (let i = 0; i < chunks.length; i++) {
                  const c = chunks[i].trim();
                  if (!c) continue;
                  let arr;
                  try {
                    arr = JSON.parse(c);
                  } catch {
                    continue;
                  }
                  if (!Array.isArray(arr) || arr[0] !== "dispatch") continue;
                  const payload = arr[2];
                  if (!payload || !payload.asin || !payload.html) continue;

                  const doc = parser.parseFromString(payload.html, "text/html");
                  const csaPrice = doc
                    .querySelector("[data-csa-c-price-to-pay]")
                    ?.getAttribute("data-csa-c-price-to-pay");
                  const offscreenPrice = doc
                    .querySelector(
                      '.a-price:not([data-a-strike="true"]) .a-offscreen'
                    )
                    ?.textContent?.trim();
                  const wholePrice = doc
                    .querySelector(
                      '.a-price:not([data-a-strike="true"]) .a-price-whole'
                    )
                    ?.textContent?.trim();

                  const currentPrice =
                    parseNumInPage(csaPrice) ??
                    parseNumInPage(offscreenPrice) ??
                    parseNumInPage(wholePrice);
                  if (!currentPrice || currentPrice <= 0) continue;

                  const mrp = parseNumInPage(
                    doc
                      .querySelector('.a-price[data-a-strike="true"] .a-offscreen')
                      ?.textContent?.trim()
                  );

                  const priceRecipeText =
                    doc.querySelector('[data-cy="price-recipe"]')?.textContent ||
                    doc.body.textContent ||
                    "";
                  let discountPct = null;

                  const mOff =
                    priceRecipeText.match(/\((\d+)\s*%\s*off\)/i) ||
                    priceRecipeText.match(/(\d+)\s*%\s*off/i) ||
                    priceRecipeText.match(/-\s*(\d+)\s*%/);
                  if (mOff) {
                    discountPct = parseFloat(mOff[1]);
                  }

                  if (mrp && mrp > currentPrice) {
                    const calcPct = ((mrp - currentPrice) / mrp) * 100;
                    if (discountPct == null || calcPct > discountPct) {
                      discountPct = Math.round(calcPct * 10) / 10;
                    }
                  }

                  if (task.minDiscountPct > 0) {
                    if (discountPct == null || discountPct < task.minDiscountPct) {
                      continue;
                    }
                  }

                  const h2List = [
                    ...doc.querySelectorAll('[data-cy="title-recipe"] h2, h2'),
                  ];
                  const titleParts = h2List
                    .map((el) =>
                      (
                        el.getAttribute("aria-label")?.trim() ||
                        el.textContent?.trim() ||
                        ""
                      )
                        .replace(/^sponsored\s+ad\s*[-–—:]\s*/i, "")
                        .trim()
                    )
                    .filter(Boolean);
                  const title =
                    [...new Set(titleParts)].join(" — ") || payload.asin;

                  found.push({
                    asin: payload.asin,
                    title,
                    currentPrice,
                    mrp,
                    discountPct,
                  });
                }
                return found;
              } catch {
                return [];
              }
            };

            const all = await Promise.all(batchTasks.map((t) => fetchOne(t)));
            return all.flat();
          },
          { batchTasks: batch }
        );
      }

      if (batchItems.length === 0) {
        consecutiveZeroRawBatches++;
        if (consecutiveZeroRawBatches >= 2) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      } else {
        consecutiveZeroRawBatches = 0;
      }

      const nowIso = new Date().toISOString();
      let batchAdded = 0;
      for (const item of batchItems) {
        if (collected.size >= targetCount) break;
        if (!collected.has(item.asin) && !usedGlobalAsins.has(item.asin)) {
          const record = compactRecord({
            asin: item.asin,
            category: cat.name,
            title: item.title,
            mrp: item.mrp,
            currentPrice: item.currentPrice,
            averagePrice: item.currentPrice,
            medianPrice: item.currentPrice,
            minPrice: item.currentPrice,
            maxPrice: item.currentPrice,
            history: [item.currentPrice],
            lastChecked: nowIso,
          });
          collected.set(item.asin, record);
          globalProducts[item.asin] = record;
          usedGlobalAsins.add(item.asin);
          batchAdded++;
        }
      }

      process.stdout.write(
        `\r   📦 [${cat.name.padEnd(28)}] ${collected.size}/${targetCount} (+${batchAdded}, raw:${batchItems.length}, wave:${wave.label}, q:${totalQueriesRun})   `
      );

      if (batchAdded < 2) {
        consecutiveStallBatches++;
        if (consecutiveStallBatches >= 3) {
          // Move immediately to next sub-wave instead of wasting queries
          break;
        }
      } else {
        consecutiveStallBatches = 0;
      }
    }
  }

  const added = collected.size - startCount;
  console.log(
    `\n   ✅ Completed [${cat.name}]: ${collected.size} products (+${added} new)`
  );
  return { skus: [...collected.keys()].slice(0, targetCount), added };
}

async function main() {
  const dataFile = path.join(__dirname, "price-data.json");
  const skuFile = path.join(__dirname, "skus.json");

  const data = loadData(dataFile);
  const skuData = loadSkus(skuFile);
  if (!skuData.categories) skuData.categories = {};

  // Compact all existing records in memory so checkpoint writes are fast & lean
  for (const [asin, prod] of Object.entries(data.products || {})) {
    data.products[asin] = compactRecord(prod);
  }

  const initialSkuCount = (skuData.skus || []).length;
  const totalTarget = CATEGORIES.reduce(
    (s, c) => s + (c.target || DEFAULT_TARGET_PER_CATEGORY),
    0
  );

  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(
    `  🛒 Amazon.in Bulk Search API Harvester (${CATEGORIES.length} Categories)`
  );
  console.log(
    `  🎯 Target: ${totalTarget.toLocaleString("en-IN")} total products (Existing: ${initialSkuCount.toLocaleString("en-IN")})`
  );
  console.log(`  🏷️  Filter: Prefer Discount >= ${MIN_DISCOUNT_PCT}% (fallback for high-volume targets)`);
  console.log("═══════════════════════════════════════════════════════════════════\n");

  // Probe fast direct HTTP first; fall back to Playwright only if challenged
  let engine = { mode: "http", page: null, context: null };
  const forcePlaywright = process.argv.includes("--playwright");
  if (!forcePlaywright) {
    console.log("🌐 Probing fast direct HTTP Search API...");
    const probeItems = await fetchSearchTaskDirectHttp(
      { qs: "k=saree&page=1", minDiscountPct: 0 },
      0,
      1
    );
    if (probeItems.length > 0) {
      console.log(
        `   ⚡ Direct HTTP Search API OK (${probeItems.length} probe items) — running at ${CONCURRENCY}x concurrency without browser!\n`
      );
    } else {
      console.warn(
        "   ⚠️  Direct HTTP probe returned 0 items — falling back to Playwright browser...\n"
      );
      engine.mode = "playwright";
    }
  } else {
    engine.mode = "playwright";
  }

  if (engine.mode === "playwright") {
    const chromium = loadPlaywrightChromium();
    if (!chromium) {
      throw new Error("Playwright is not available for fallback mode.");
    }
    engine.context = await chromium.launchPersistentContext(
      path.join(__dirname, "browser-data"),
      {
        headless: true,
        viewport: { width: 1366, height: 768 },
        userAgent: USER_AGENTS[0],
        locale: "en-IN",
        timezoneId: "Asia/Kolkata",
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
      }
    );
    engine.page = engine.context.pages()[0] || (await engine.context.newPage());
    console.log("🌐 Connecting to Amazon.in via Playwright...");
    await engine.page.goto("https://www.amazon.in/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  }

  const startMs = Date.now();

  try {
    // Pre-reserve ALL existing ASINs across ALL existing categories so no category
    // ever steals an ASIN from another category and every added SKU is genuinely new.
    const usedGlobalAsins = new Set();
    for (const asinList of Object.values(skuData.categories)) {
      for (const asin of asinList || []) {
        usedGlobalAsins.add(asin);
      }
    }
    for (const asin of skuData.skus || []) {
      usedGlobalAsins.add(asin);
    }

    let totalAdded = 0;

    for (let i = 0; i < CATEGORIES.length; i++) {
      const cat = CATEGORIES[i];
      const { skus: catSkus, added } = await harvestCategory(
        engine,
        cat,
        skuData.categories,
        data.products,
        usedGlobalAsins
      );
      skuData.categories[cat.name] = catSkus;
      totalAdded += added;

      // Save crash-safe checkpoint after every category that harvested new products or on final category
      if (added > 0 || i === CATEGORIES.length - 1) {
        skuData.skus = [
          ...new Set(Object.values(skuData.categories).flat()),
        ];
        fs.writeFileSync(skuFile, JSON.stringify(skuData, null, 2), "utf-8");
        data.lastRun = new Date().toISOString();
        data.runCount = (data.runCount || 0) + 1;
        fs.writeFileSync(dataFile, JSON.stringify(data), "utf-8");
        const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
        console.log(
          `   💾 Checkpoint saved (${elapsedSec}s) — Total unique SKUs: ${skuData.skus.length.toLocaleString("en-IN")} (+${totalAdded.toLocaleString("en-IN")} new this run)`
        );
      }
    }

    const totalSec = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log("\n═══════════════════════════════════════════════════════════════════");
    console.log(
      `  🎉 Harvest Complete in ${totalSec}s! Total Categories: ${CATEGORIES.length} | Total Unique SKUs: ${skuData.skus.length.toLocaleString("en-IN")} (+${totalAdded.toLocaleString("en-IN")} new)`
    );
    console.log("═══════════════════════════════════════════════════════════════════\n");
  } finally {
    if (engine.context) {
      await engine.context.close();
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
