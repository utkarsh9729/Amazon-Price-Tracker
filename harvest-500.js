// ============================================================================
// Amazon.in Search API Bulk Category Harvester
// ============================================================================
// Uses the reverse-engineered Amazon Search API (`POST /s/query`) inside
// Playwright with concurrent fetch workers to harvest unique products for
// 61 popular categories (11 original categories + 50 new popular categories,
// with at least 250 products per new category).
// Rule: No price rule; ONLY discount rule > 30% off.
// ============================================================================

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const DEFAULT_TARGET_PER_CATEGORY = 250;
const MIN_DISCOUNT_PCT = 30; // Strictly > 30% discount rule (no price rule)
const CONCURRENCY = 12;

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
    target: 250,
    queries: [
      "robotic vacuum cleaner and mop",
      "cordless stick vacuum cleaner",
      "wet and dry vacuum cleaner",
      "handheld car vacuum cleaner",
      "bagless canister vacuum cleaner",
      "eureka forbes agaro philips vacuum",
      "dyson dreame ecovacs ilife robot vacuum",
      "sofa carpet mattress vacuum cleaner",
      "blower vacuum cleaner home",
      "high suction cyclonic vacuum",
      "steam mop cleaner",
      "upright vacuum cleaner",
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
  "p_n_pct-off-with-tax:2665401031", // 35% Off or more (all items > 30% off)
  "p_n_pct-off-with-tax:2665400031", // 25% Off or more
  "p_n_pct-off-with-tax:2665402031", // 50% Off or more
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

async function harvestCategory(
  page,
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
    if (p && !usedGlobalAsins.has(asin)) {
      p.category = cat.name;
      collected.set(asin, p);
      usedGlobalAsins.add(asin);
    }
  }

  if (collected.size >= targetCount) {
    console.log(
      `   ⏭️  [${cat.name.padEnd(17)}] Already has ${collected.size}/${targetCount} products`
    );
    return [...collected.keys()].slice(0, targetCount);
  }

  // Build candidate Search API task queue (No price rule; strictly > 30% discount rule)
  const tasks = [];

  // Wave 1: 35%+ off discount facet across queries (guarantees > 30% discount)
  for (let pageNum = 1; pageNum <= 4; pageNum++) {
    for (const q of cat.queries) {
      tasks.push({
        qs: `k=${encodeURIComponent(q)}&rh=${encodeURIComponent(DISCOUNT_BUCKETS[0])}&s=relevanceblender&page=${pageNum}`,
      });
    }
  }

  // Wave 2: Unfiltered queries across multiple sort orders & pages (filtered for > 30% discount in parser)
  for (const sort of SORT_ORDERS) {
    for (let pageNum = 1; pageNum <= 5; pageNum++) {
      for (const q of cat.queries) {
        tasks.push({
          qs: `k=${encodeURIComponent(q)}&s=${sort}&page=${pageNum}`,
        });
      }
    }
  }

  // Wave 3: 25%+ and 50%+ discount facets with extra sort orders if still needed
  for (const bucket of DISCOUNT_BUCKETS.slice(1)) {
    for (const sort of SORT_ORDERS.slice(0, 3)) {
      for (let pageNum = 1; pageNum <= 5; pageNum++) {
        for (const q of cat.queries) {
          tasks.push({
            qs: `k=${encodeURIComponent(q)}&rh=${encodeURIComponent(bucket)}&s=${sort}&page=${pageNum}`,
          });
        }
      }
    }
  }

  let taskIdx = 0;

  while (collected.size < targetCount && taskIdx < tasks.length) {
    const batch = tasks.slice(taskIdx, taskIdx + CONCURRENCY);
    taskIdx += CONCURRENCY;

    const batchItems = await page.evaluate(
      async ({ batchTasks, minDiscountPct }) => {
        const parseNum = (s) => {
          if (!s) return null;
          const cleaned = String(s).replace(/[^\d.]/g, "");
          const n = parseFloat(cleaned);
          return isNaN(n) ? null : n;
        };

        const parser = new DOMParser();

        const fetchOne = async (qs) => {
          try {
            const res = await fetch(`/s/query?${qs}`, {
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
                parseNum(csaPrice) ??
                parseNum(offscreenPrice) ??
                parseNum(wholePrice);
              if (!currentPrice || currentPrice <= 0) continue;

              const mrp = parseNum(
                doc
                  .querySelector('.a-price[data-a-strike="true"] .a-offscreen')
                  ?.textContent?.trim()
              );

              // Extract discount percentage (strictly > 30% required; no minimum price rule)
              const priceRecipeText =
                doc.querySelector('[data-cy="price-recipe"]')?.textContent ||
                doc.body.textContent ||
                "";
              let discountPct = null;
              let discountText = null;

              const mOff =
                priceRecipeText.match(/\((\d+)\s*%\s*off\)/i) ||
                priceRecipeText.match(/(\d+)\s*%\s*off/i) ||
                priceRecipeText.match(/-\s*(\d+)\s*%/);
              if (mOff) {
                discountPct = parseFloat(mOff[1]);
                discountText = `(${Math.round(discountPct)}% off)`;
              }

              if (mrp && mrp > currentPrice) {
                const calcPct = ((mrp - currentPrice) / mrp) * 100;
                if (discountPct == null || calcPct > discountPct) {
                  discountPct = Math.round(calcPct * 10) / 10;
                }
                if (!discountText) {
                  discountText = `(${Math.round(calcPct)}% off)`;
                }
              }

              if (discountPct == null || discountPct <= minDiscountPct) {
                continue;
              }

              const h2List = [
                ...doc.querySelectorAll('[data-cy="title-recipe"] h2, h2'),
              ];
              const titleParts = h2List
                .map(
                  (el) =>
                    el.getAttribute("aria-label")?.trim() ||
                    el.textContent?.trim()
                )
                .filter(Boolean);
              const title =
                [...new Set(titleParts)].join(" — ") || payload.asin;

              const dealBadge =
                doc.querySelector(".a-badge-text")?.textContent?.trim() || null;
              const merchantEl =
                doc.querySelector("[data-csa-c-merchant-id]") ||
                doc.querySelector('input[name="merchantId"]');
              const merchantId =
                merchantEl?.getAttribute("data-csa-c-merchant-id") ||
                merchantEl?.getAttribute("value") ||
                null;
              const imageUrl =
                doc.querySelector("img.s-image")?.getAttribute("src") || null;

              found.push({
                asin: payload.asin,
                title,
                currentPrice,
                mrp,
                discountPct,
                dealBadge,
                discountText,
                merchantId,
                imageUrl,
              });
            }
            return found;
          } catch {
            return [];
          }
        };

        const all = await Promise.all(batchTasks.map((t) => fetchOne(t.qs)));
        return all.flat();
      },
      { batchTasks: batch, minDiscountPct: MIN_DISCOUNT_PCT }
    );

    const nowIso = new Date().toISOString();
    for (const item of batchItems) {
      if (collected.size >= targetCount) break;
      if (!collected.has(item.asin) && !usedGlobalAsins.has(item.asin)) {
        const record = {
          asin: item.asin,
          category: cat.name,
          title: item.title,
          mrp: item.mrp,
          currentPrice: item.currentPrice,
          averagePrice: item.currentPrice,
          medianPrice: item.currentPrice,
          minPrice: item.currentPrice,
          maxPrice: item.currentPrice,
          discountPct: item.discountPct,
          discountText: item.discountText,
          dealBadge: item.dealBadge,
          merchantId: item.merchantId,
          imageUrl: item.imageUrl,
          history: [
            {
              price: item.currentPrice,
              mrp: item.mrp,
              isDeal: Boolean(item.dealBadge),
              dealBadge: item.dealBadge,
              merchantId: item.merchantId,
              timestamp: nowIso,
            },
          ],
          lastChecked: nowIso,
          alertCount: 0,
          firstSeen: nowIso,
        };
        collected.set(item.asin, record);
        globalProducts[item.asin] = record;
        usedGlobalAsins.add(item.asin);
      }
    }

    process.stdout.write(
      `\r   📦 [${cat.name.padEnd(17)}] Harvested: ${collected.size}/${targetCount} (queries: ${taskIdx}/${tasks.length})`
    );
  }

  console.log(
    `\n   ✅ Completed [${cat.name}]: ${collected.size} products (Discount > ${MIN_DISCOUNT_PCT}%)`
  );
  return [...collected.keys()].slice(0, targetCount);
}

async function main() {
  const dataFile = path.join(__dirname, "price-data.json");
  const skuFile = path.join(__dirname, "skus.json");

  const data = loadData(dataFile);
  const skuData = loadSkus(skuFile);
  if (!skuData.categories) skuData.categories = {};

  const totalTarget = CATEGORIES.reduce(
    (s, c) => s + (c.target || DEFAULT_TARGET_PER_CATEGORY),
    0
  );

  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(
    `  🛒 Amazon.in Bulk Search API Harvester (${CATEGORIES.length} Categories)`
  );
  console.log(`  🎯 Target: ${totalTarget.toLocaleString("en-IN")} total products (≥ 250/category)`);
  console.log(`  🏷️  Filter: Discount > ${MIN_DISCOUNT_PCT}% (No minimum price rule)`);
  console.log("═══════════════════════════════════════════════════════════════════\n");

  const context = await chromium.launchPersistentContext(
    path.join(__dirname, "browser-data"),
    {
      headless: true,
      viewport: { width: 1366, height: 768 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-IN",
      timezoneId: "Asia/Kolkata",
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    }
  );

  const page = context.pages()[0] || (await context.newPage());

  try {
    console.log("🌐 Connecting to Amazon.in Search API...");
    await page.goto("https://www.amazon.in/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const allSkus = [];
    const usedGlobalAsins = new Set();

    // Reserve existing SKUs first so new categories never steal an ASIN from an existing category
    for (const cat of CATEGORIES) {
      for (const asin of skuData.categories[cat.name] || []) {
        if (data.products[asin]) {
          usedGlobalAsins.add(asin);
        }
      }
    }
    // Clear and re-track inside harvestCategory
    usedGlobalAsins.clear();

    for (let i = 0; i < CATEGORIES.length; i++) {
      const cat = CATEGORIES[i];
      const catSkus = await harvestCategory(
        page,
        cat,
        skuData.categories,
        data.products,
        usedGlobalAsins
      );
      skuData.categories[cat.name] = catSkus;
      allSkus.push(...catSkus);

      // Save checkpoint every 5 categories or on final category
      if ((i + 1) % 5 === 0 || i === CATEGORIES.length - 1) {
        skuData.skus = [...new Set(allSkus)];
        fs.writeFileSync(skuFile, JSON.stringify(skuData, null, 2), "utf-8");
        data.lastRun = new Date().toISOString();
        data.runCount = (data.runCount || 0) + 1;
        fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), "utf-8");
      }
    }

    console.log("\n═══════════════════════════════════════════════════════════════════");
    console.log(
      `  🎉 Harvest Complete! Total Categories: ${CATEGORIES.length} | Total Unique SKUs: ${skuData.skus.length}`
    );
    for (const cat of CATEGORIES) {
      console.log(
        `     • ${cat.name.padEnd(18)}: ${(skuData.categories[cat.name] || []).length} SKUs`
      );
    }
    console.log("═══════════════════════════════════════════════════════════════════\n");
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
