/**
 * emoji.js — the badge catalogue and the picker that browses it.
 *
 * A badge is how a five-year-old finds their own seat in the chamber: they do
 * not read the roster, they look for the fox. Sixteen hard-coded choices meant
 * cousins ended up sharing a badge, which defeats the whole point, so the
 * catalogue here is deliberately large and searchable instead.
 *
 * Every glyph is a single code point with default emoji presentation. That is
 * the same rule icons.js follows and it is not fussiness: a ZWJ sequence, a
 * skin-tone modifier or a variation selector can be split by a chat app, a
 * database column, or an older font, and a badge that arrives on a cousin's
 * phone as two boxes is worse than no badge. It also keeps [...string] honest,
 * so a badge is exactly one character everywhere we count characters.
 *
 * Nothing here builds markup from strings, so ui.js's esc/h are not imported —
 * every node is made with the DOM API and every label goes in via textContent,
 * which is the escaping. Names and keywords are ours, but the picker is also
 * handed member-chosen values, and one code path is easier to keep safe than
 * two.
 */

/* --------------------------------------------------------------------------
   Catalogue

   Stored as lines rather than object literals: at this size the object form is
   mostly punctuation, and a wall of `{ char: "🦊", name: ... }` is far harder
   to scan for the duplicate or the missing keyword than a column of glyphs.
   One line per emoji — glyph, space, name, "|", space-separated keywords.
   -------------------------------------------------------------------------- */

const GROUP_SOURCE = [
  ["faces", "Faces", "😀", `
😀 grin|happy smile laugh
😃 big smile|happy grin open
😄 beaming|happy smile eyes
😁 grinning teeth|happy smile beam
😆 laughing|haha giggle squint
😅 nervous laugh|sweat phew haha
🤣 rolling laughing|rofl hilarious funny
😂 tears of joy|crying laughing funny
🙂 slight smile|content polite okay
🙃 upside down|silly flip topsy
😉 wink|cheeky joke
😊 blushing smile|happy shy warm
😇 halo|angel good innocent
🥰 hearts smile|love adore fond
😍 heart eyes|love adore crush
🤩 starstruck|amazed wow dazzled
😘 blowing kiss|love kiss
😗 kissing face|whistle pucker
😋 yum|tasty delicious tongue
😛 tongue out|cheeky silly
😜 winking tongue|silly joke cheeky
🤪 zany|silly wild goofy
😝 squinting tongue|silly yuck
🤑 money face|rich cash greedy
🤗 hug|warm welcome hands
🤭 oops|giggle shy hand
🤫 shush|quiet secret hush
🤔 thinking|hmm ponder wonder
🤐 zipped lips|secret quiet
🤨 raised brow|suspicious doubt
😐 neutral|blank meh straight
😑 expressionless|blank meh
😶 no mouth|speechless quiet
😏 smirk|sly smug
😒 unamused|meh annoyed
🙄 eye roll|whatever annoyed
😬 grimace|awkward yikes
😌 relieved|calm content peaceful
😔 downcast|sad glum pensive
😪 sleepy|tired drowsy
🤤 drooling|hungry yum
😴 asleep|sleeping zzz snooze
😷 face mask|poorly germs
🤒 thermometer face|sick fever ill
🤕 bandaged head|hurt injured ouch
🤢 queasy|sick yuck green
🤧 sneeze|cold tissue achoo
🥵 overheated|hot sweaty
🥶 freezing|cold icy chilly
😵 dizzy|woozy knocked
🤯 mind blown|shocked wow explode
🤠 cowboy|hat yeehaw
🥳 party face|celebrate birthday
😎 sunglasses face|cool shades
🤓 nerd|glasses clever
🧐 monocle|inspect curious
😕 confused|unsure puzzled
😟 worried|anxious concerned
🙁 slight frown|sad glum
😮 surprised|oh gasp
😯 hushed|startled quiet
😲 astonished|shocked gasp
😳 flushed|embarrassed blush
🥺 pleading|puppy eyes please
😦 open frown|worried
😨 fearful|scared afraid
😰 anxious sweat|nervous worried
😢 crying|tear sad upset
😭 sobbing|bawling weeping
😱 screaming|shocked terrified
😖 confounded|frustrated
😣 persevering|struggling
😩 weary|tired fed up
😫 exhausted|worn out tired
🥱 yawn|sleepy bored
😤 huffing|steam cross determined
😡 furious|angry red mad
😠 cross face|angry grumpy
🤬 fuming|angry swearing
🤡 clown|circus funny
👻 ghost|boo spooky
👽 alien|space martian
👾 space invader|arcade retro alien
🤖 robot|bot machine
💩 poo|silly smelly
😺 happy cat|smiling kitty
😸 grinning cat|kitty pleased
😹 laughing cat|kitty funny
😻 lovestruck cat|kitty hearts
😼 wry cat|kitty smug
😽 kissing cat|kitty love
🙀 shocked cat|kitty surprised
😿 crying cat|kitty sad
`],

  ["animals", "Animals", "🦊", `
🐶 dog|puppy pet woof
🐱 cat|kitty pet meow
🐭 mouse|squeak small
🐹 hamster|pet cheeks
🐰 rabbit|bunny hop
🦊 fox|clever brush
🐻 bear|grizzly woods
🐼 panda|bamboo
🐨 koala|gum tree
🐯 tiger|stripes roar
🦁 lion|mane roar
🐮 cow|moo farm
🐷 pig|oink farm
🐸 frog|ribbit pond
🐵 monkey|cheeky ape
🙈 see no evil|monkey hide eyes
🙉 hear no evil|monkey ears
🙊 speak no evil|monkey quiet
🐒 climbing monkey|ape swing
🐔 chicken|hen cluck farm
🐧 penguin|ice waddle
🐦 bird|tweet fly
🐤 chick|baby bird
🐣 hatching chick|egg baby
🐥 fluffy chick|baby bird
🦆 duck|quack pond
🦅 eagle|soar prey
🦉 owl|hoot wise night
🦇 bat|night cave
🐺 wolf|howl pack
🐗 boar|tusks wild
🐴 horse|pony neigh
🦄 unicorn|magic horn
🐝 bee|buzz honey
🐛 caterpillar|bug crawl
🦋 butterfly|wings flutter
🐌 snail|slow shell
🐞 ladybird|beetle spots luck
🐜 ant|tiny busy
🦗 cricket|chirp grasshopper
🦂 scorpion|sting desert
🐢 turtle|tortoise shell
🐍 snake|slither hiss
🦎 lizard|gecko reptile
🦖 t rex|dinosaur roar
🦕 long neck dinosaur|sauropod
🐘 elephant|trunk big
🦛 hippo|river wallow
🦏 rhino|horn charge
🐪 camel|desert hump
🐫 two hump camel|desert
🦒 giraffe|tall neck
🦘 kangaroo|hop pouch
🐃 buffalo|water ox
🐂 ox|plough strong
🐄 dairy cow|milk farm
🐎 racehorse|gallop
🐖 farm pig|snout mud
🐏 ram|horns sheep
🐑 sheep|wool baa
🦙 llama|fluffy spit
🐐 goat|bleat butt
🦌 deer|antlers forest
🐕 walking dog|lead pet
🐩 poodle|dog fancy
🦮 guide dog|helper harness
🐈 prowling cat|pet tail
🐓 rooster|cockerel crow
🦃 turkey|gobble
🦚 peacock|feathers proud
🦜 parrot|talk colourful
🦢 swan|graceful lake
🦩 flamingo|pink wading
🐇 hopping rabbit|bunny ears
🦝 raccoon|masked bandit
🦨 skunk|stinky stripe
🦡 badger|sett stripe
🦦 otter|river playful
🦥 sloth|slow hang
🐁 little mouse|squeak tiny
🐀 rat|rodent tail
🦔 hedgehog|prickly spines
🐾 paw prints|tracks trail
🦓 zebra|stripes
🦍 gorilla|ape strong
🦧 orangutan|ape ginger
🐅 stalking tiger|stripes
🐆 leopard|spots fast
🐊 crocodile|snap jaws
🦬 bison|plains herd
🦣 mammoth|tusks ice age
🦫 beaver|dam teeth
🪱 worm|wiggle soil
🪰 fly|buzz wings
🪲 beetle|shell bug
`],

  ["sea", "Sea & Sky", "🌊", `
🐙 octopus|tentacles sea
🦑 squid|ink sea
🦐 shrimp|prawn sea
🦞 lobster|claws sea
🦀 crab|claws beach
🐡 pufferfish|spiky sea
🐠 tropical fish|reef colourful
🐟 fish|swim sea
🐬 dolphin|clever leap
🐳 spouting whale|sea big
🐋 whale|sea huge
🦈 shark|fin teeth
🐚 shell|beach spiral
🪸 coral|reef sea
🌊 wave|sea surf water
⛵ sailing boat|sail wind
🚤 speedboat|fast wake
🛶 canoe|paddle river
🚢 ship|cruise sea
⚓ anchor|harbour ship
🌍 earth europe|globe world
🌎 earth americas|globe world
🌏 earth asia|globe world
🌕 full moon|bright night
🌖 waning gibbous moon|night wane
🌗 last quarter moon|half night
🌘 waning crescent moon|night wane
🌑 new moon|dark night
🌒 waxing crescent moon|night wax
🌓 first quarter moon|half night
🌔 waxing gibbous moon|night wax
🌙 crescent moon|night sleep
🌛 moon smiling left|night face
🌜 moon smiling right|night face
🌝 full moon face|bright grin
🌚 new moon face|dark grin
🌞 sun face|day bright grin
⭐ star|night twinkle
🌟 glowing star|shine sparkle
💫 dizzy star|swirl spin
✨ sparkles|magic glitter shine
🪐 ringed planet|saturn space
🌠 shooting star|wish night
🌌 milky way|galaxy space night
🚀 rocket|space launch blast
🛸 flying saucer|ufo alien
🌅 sunrise|dawn sea
🌄 sunrise over hills|dawn
🌇 sunset|dusk city
🌆 city at dusk|evening skyline
🌃 city at night|stars skyline
🌉 bridge at night|river lights
🌁 foggy|mist haze
🗻 snowy peak|fuji mountain
🌋 volcano|erupt lava
`],

  ["food", "Food & Treats", "🍕", `
🍏 green apple|fruit crunch
🍎 red apple|fruit
🍐 pear|fruit
🍊 orange|citrus fruit
🍋 lemon|sour citrus
🍌 banana|fruit peel
🍉 watermelon|fruit summer
🍇 grapes|fruit bunch
🍓 strawberry|fruit sweet
🫐 blueberries|fruit berry
🍈 melon|fruit
🍒 cherries|fruit pair
🍑 peach|fruit fuzzy
🥭 mango|fruit tropical
🍍 pineapple|fruit tropical
🥥 coconut|tropical shell
🥝 kiwi|fruit green
🍅 tomato|salad red
🍆 aubergine|eggplant purple
🥑 avocado|toast stone
🥦 broccoli|greens vegetable
🥬 leafy greens|salad vegetable
🥒 cucumber|salad crunch
🌽 sweetcorn|maize cob
🥕 carrot|vegetable crunch
🧄 garlic|clove bulb
🧅 onion|layers vegetable
🥔 potato|spud
🍠 roast sweet potato|yam
🥐 croissant|pastry flaky
🥯 bagel|bread ring
🍞 bread|loaf toast
🥖 baguette|bread stick
🥨 pretzel|salty twist
🧀 cheese|dairy wedge
🥚 egg|shell breakfast
🍳 fried egg|pan breakfast
🧈 butter|dairy spread
🥞 pancakes|stack syrup
🧇 waffle|syrup breakfast
🥓 bacon|rasher breakfast
🍗 chicken leg|drumstick roast
🍖 meat on the bone|roast
🦴 bone|skeleton treat
🌭 hot dog|sausage bun
🍔 burger|beef bun
🍟 chips|fries
🍕 pizza|slice cheese
🥪 sandwich|lunch butty
🥙 stuffed flatbread|pitta wrap
🧆 falafel|snack
🌮 taco|shell mexican
🌯 burrito|wrap mexican
🥗 salad|greens bowl
🥘 pan of food|paella dinner
🍝 spaghetti|pasta dinner
🍜 noodles|ramen slurp
🍲 stew|pot dinner
🍛 curry|rice plate
🍣 sushi|fish rice
🍱 bento|lunch box
🥟 dumpling|steamed
🍤 prawn tempura|fried
🍙 rice ball|onigiri
🍚 bowl of rice|steamed
🍥 fish cake|swirl
🥠 fortune cookie|message
🍢 skewers|oden grill
🍡 dango|sweet skewer
🍧 shaved ice|cold treat
🍨 ice cream|scoops dessert
🍦 ice cream cone|whippy soft
🥧 pie|slice bake
🧁 cupcake|bun icing
🍰 slice of cake|dessert
🎂 birthday cake|candles party
🍮 custard|pudding flan
🍭 lollipop|sweet swirl
🍬 sweet|candy wrapper
🍫 chocolate|bar cocoa
🍿 popcorn|cinema snack
🍩 doughnut|donut icing
🍪 biscuit|cookie crumbs
🌰 chestnut|nut autumn
🥜 peanuts|nuts snack
🍯 honey|pot jar
🥛 milk|glass dairy
🍼 baby bottle|milk feed
🧃 juice box|straw drink
🧋 bubble tea|boba drink
☕ hot drink|coffee tea mug
🍵 green tea|cup brew
🧊 ice cube|cold frozen
🥤 cup with straw|fizzy drink
🥄 spoon|cutlery stir
🍴 knife and fork|cutlery dinner
🧂 salt|shaker season
🥣 bowl with spoon|cereal breakfast
`],

  ["plants", "Plants & Weather", "🌻", `
🌵 cactus|desert prickly
🎄 christmas tree|festive fir
🌲 evergreen|pine forest
🌳 broadleaf tree|park shade
🌴 palm tree|beach tropical
🌱 seedling|sprout grow
🌿 herb|leaves sprig
🍀 four leaf clover|luck shamrock
🎍 pine decoration|bamboo new year
🎋 wish tree|tanabata bamboo
🍃 leaf in wind|breeze flutter
🍂 fallen leaves|autumn
🍁 maple leaf|autumn
🍄 mushroom|toadstool forest
🌾 wheat|grain field
💐 bouquet|flowers gift
🌷 tulip|flower spring
🌹 rose|flower thorn
🥀 wilted flower|droop
🌺 hibiscus|flower tropical
🌻 sunflower|flower tall
🌼 blossom|daisy flower
🌸 cherry blossom|sakura spring
🪷 lotus|pond flower
🪴 potted plant|houseplant pot
🪵 log|wood timber
🪨 rock|stone pebble
☔ umbrella in rain|wet shower
⛄ snowman|winter cold
🌈 rainbow|colours arc
⚡ lightning|bolt storm zap
💧 droplet|water drip
💦 splash|water spray
🌀 cyclone|swirl storm
`],

  ["sport", "Sport & Games", "⚽", `
⚽ football|soccer ball kick
🏀 basketball|hoop ball
🏈 american football|ball
⚾ baseball|ball bat
🥎 softball|ball bat
🎾 tennis|ball racket
🏐 volleyball|ball net
🏉 rugby|ball scrum
🥏 flying disc|frisbee throw
🎱 pool ball|snooker eight
🪀 yo yo|toy string
🏓 table tennis|ping pong bat
🏸 badminton|shuttlecock racket
🏒 ice hockey|stick puck
🏑 field hockey|stick ball
🥍 lacrosse|stick net
🏏 cricket bat|ball wicket
🥅 goal net|score
⛳ golf hole|flag green
🪁 kite|string wind fly
🏹 bow and arrow|archery aim
🎣 fishing rod|catch reel
🤿 diving mask|snorkel dive
🥊 boxing glove|punch
🥋 martial arts suit|judo karate belt
🎽 running vest|race number
🛹 skateboard|skate trick
🛼 roller skates|skate wheels
🛷 sledge|sled snow
🥌 curling stone|ice sweep
🎿 skis|snow slope
🏂 snowboarder|snow slope
🏄 surfer|wave board
🏊 swimmer|pool stroke
🚴 cyclist|bike ride
🚵 mountain biker|bike trail
🏆 trophy|win champion cup
🥇 gold medal|first win
🥈 silver medal|second
🥉 bronze medal|third
🏅 sports medal|ribbon win
🎯 bullseye|darts target aim
🎮 game controller|video game play
🎲 dice|board game roll
🧩 jigsaw|puzzle piece
🎰 slot machine|jackpot spin
🃏 joker|card wild
🀄 mahjong tile|game
🎴 flower cards|game deck
🎪 circus tent|big top show
🪃 boomerang|throw return
🪄 magic wand|spell trick
🧸 teddy bear|toy cuddle
🪅 pinata|party sweets
🪆 nesting dolls|toy stacking
`],

  ["music", "Music & Art", "🎨", `
🎼 sheet music|score stave
🎵 musical note|tune
🎶 musical notes|tune melody
🎤 microphone|sing karaoke
🎧 headphones|listen music
📻 radio|broadcast listen
🎷 saxophone|jazz brass
🪗 accordion|squeezebox folk
🎸 guitar|strings rock
🎹 piano keys|keyboard music
🎺 trumpet|brass fanfare
🎻 violin|strings fiddle
🥁 drum|beat percussion
🪘 long drum|conga beat
🪕 banjo|strings folk
🎬 clapperboard|film action
🎥 movie camera|film reel
📷 camera|photo snap
📸 camera flash|photo snap
📹 video camera|record film
📺 television|telly watch
💿 compact disc|cd music
📀 dvd|disc film
🎨 palette|paint art
📝 memo|write notes
📖 open book|read story
🎭 theatre masks|drama play
🎫 ticket|show entry
🔔 bell|ring chime
📢 loudspeaker|announce loud
📣 megaphone|cheer shout
🔊 loud speaker|volume sound
🪩 disco ball|party mirror
🧵 thread|sew spool
🧶 yarn|knit wool
🩰 ballet shoes|dance pointe
💃 dancer|dance flamenco
🕺 dancing man|dance disco
`],

  ["travel", "Travel & Places", "🏰", `
🚗 car|drive road
🚕 taxi|cab fare
🚙 four by four|jeep car
🚌 bus|stop ride
🚎 trolleybus|ride wires
🚐 minibus|van
🚚 lorry|truck delivery
🚛 articulated lorry|truck trailer
🚜 tractor|farm plough
🚓 police car|siren
🚑 ambulance|siren hospital
🚒 fire engine|siren
🛴 kick scooter|ride
🚲 bicycle|bike pedal
🛵 moped|motor scooter
🚨 siren light|emergency flash
🚦 traffic light|stop go
🚥 crossing lights|stop go
🚧 roadworks|barrier
⛽ fuel pump|petrol station
🚁 helicopter|rotor fly
🛫 taking off|departure plane
🛬 landing|arrival plane
💺 seat|window aisle
🚂 steam engine|train loco
🚆 train|rail carriages
🚇 underground|metro tube
🚊 tram|rail street
🚉 station|platform
🚄 bullet train|fast rail
🚞 mountain railway|train
🚡 cable car|aerial ride
🚠 mountain cableway|gondola
🎡 big wheel|ferris fair
🎢 rollercoaster|fair ride
🎠 carousel|merry go round
⛲ fountain|square water
🗿 stone head|moai statue
🗽 liberty statue|new york
🗼 tall tower|landmark
🏰 castle|turret fairy tale
🏯 japanese castle|pagoda
🏠 house|home
🏡 house with garden|home
🏢 office block|building
🏥 hospital|doctor
🏦 bank|money building
🏨 hotel|stay
🏪 corner shop|convenience
🏫 school|classroom
🏬 department store|shops
🏭 factory|works chimney
⛪ church|steeple
🗾 map of japan|country
🧭 compass|direction navigate
🎑 moon viewing|festival
🛝 playground slide|park slide
🛞 wheel|tyre roll
🧳 luggage|suitcase travel
🎒 backpack|school bag
`],

  ["objects", "Objects", "💡", `
⌚ watch|wrist time
📱 mobile phone|smartphone call
💻 laptop|computer
💽 minidisc|storage
💾 floppy disk|save storage
📼 videotape|vhs
📞 telephone|receiver call
📟 pager|beeper
📠 fax machine|print
🔋 battery|power charge
🔌 plug|power socket
💡 light bulb|idea bright
🔦 torch|flashlight beam
🧯 fire extinguisher|safety
💸 money with wings|spend
💵 dollar note|money
💴 yen note|money
💶 euro note|money
💷 pound note|money
💰 money bag|treasure
💳 bank card|pay
💎 gem|diamond jewel
🧰 toolbox|tools fix
🔧 spanner|wrench fix
🔨 hammer|nail build
🪛 screwdriver|screw fix
🔩 nut and bolt|fix
🧲 magnet|attract
🪓 axe|chop wood
🔪 kitchen knife|chop cook
🧨 firecracker|bang fuse
🎆 fireworks|night display
🎇 sparkler|night fizz
🔮 crystal ball|fortune magic
📿 beads|string necklace
🧿 lucky eye|charm amulet
💈 barber pole|haircut stripe
🔭 telescope|stars look
🔬 microscope|science tiny
🧪 test tube|science lab
🧫 petri dish|science lab
🧬 dna|genes science
💊 pill|medicine tablet
💉 syringe|injection jab
🩹 plaster|bandage cut
🩺 stethoscope|doctor listen
🚪 door|entrance handle
🚿 shower|wash water
🛁 bath|tub soak
🧴 lotion bottle|soap pump
🧷 safety pin|fasten
🧹 broom|sweep
🧺 basket|laundry picnic
🧻 toilet roll|paper
🧼 soap|wash bubbles
🧽 sponge|clean wipe
🔑 key|lock unlock
🎁 present|gift wrapped
🎈 balloon|party float
🎉 party popper|celebrate
🎊 confetti ball|celebrate
🎀 ribbon|bow gift
🎃 pumpkin lantern|halloween carved
📦 parcel|box delivery
📫 postbox|mail letters
📮 letterbox|post mail
📚 books|read library
📔 notebook|write cover
📒 ledger|notes accounts
📕 closed book|read
📗 green book|read
📘 blue book|read
📙 orange book|read
📰 newspaper|news read
🔖 bookmark|page save
📌 pushpin|pin note
📍 map pin|location place
📎 paperclip|attach
📏 ruler|measure straight
📐 set square|measure angle
🧮 abacus|count maths
🔍 magnifying glass|search look
🔎 magnifier right|search find
🔒 locked|padlock secure
🔓 unlocked|padlock open
🔐 lock with key|secure
⏰ alarm clock|wake time
⏳ hourglass|sand time
⌛ hourglass done|sand time
📡 satellite dish|signal
👑 crown|king queen royal
🎩 top hat|magic formal
🧢 cap|baseball hat
👟 trainer|shoe run
🥾 hiking boot|walk
🧦 socks|feet warm
🧤 gloves|hands warm
🧣 scarf|winter warm
👓 glasses|specs see
🌂 closed umbrella|rain furled
🪑 chair|seat sit
`],

  ["symbols", "Symbols & Shapes", "💜", `
🧡 orange heart|love
💛 yellow heart|love
💚 green heart|love
💙 blue heart|love
💜 purple heart|love
🖤 black heart|love
🤍 white heart|love
🤎 brown heart|love
💔 broken heart|sad split
💕 two hearts|love pair
💞 revolving hearts|love spin
💓 beating heart|love pulse
💗 growing heart|love
💖 sparkling heart|love shine
💘 heart with arrow|cupid love
💝 heart with ribbon|gift love
💟 heart decoration|love
💌 love letter|note post
💤 zzz|sleep snore
💬 speech bubble|talk say
💭 thought bubble|think dream
💥 collision|bang boom
💨 dash|puff fast
🔥 fire|flame hot
💯 hundred|score perfect
✅ tick|check done yes
❌ cross|wrong no
❎ cross button|wrong no
➕ plus|add sum
➖ minus|subtract take
➗ divide|maths
❓ question mark|ask query
❔ white question mark|ask
❕ white exclamation mark|surprise
❗ exclamation mark|shout important
🔴 red circle|dot
🟠 orange circle|dot
🟡 yellow circle|dot
🟢 green circle|dot
🔵 blue circle|dot
🟣 purple circle|dot
🟤 brown circle|dot
⚫ black circle|dot
⚪ white circle|dot
🟥 red square|block
🟧 orange square|block
🟨 yellow square|block
🟩 green square|block
🟦 blue square|block
🟪 purple square|block
🟫 brown square|block
⬛ black square|block
⬜ white square|block
🔶 orange diamond|shape
🔷 blue diamond|shape
🔸 small orange diamond|shape
🔹 small blue diamond|shape
🔺 triangle up|shape point
🔻 triangle down|shape point
💠 diamond with dot|shape
🔘 radio button|dot select
🔳 white button|square shape
🔲 black button|square shape
⭕ big ring|circle round
🔝 top arrow|up
🔙 back arrow|return
🔜 soon arrow|next
🔛 on arrow|here
🔚 end arrow|finish
🆗 ok button|fine
🆕 new button|fresh
🆒 cool button|nice
🆙 up button|level
🆓 free button|no cost
🔠 capital letters|abc type
🔡 small letters|abc type
🔢 numbers|digits count
🔣 symbols|characters
🔤 alphabet|abc letters
♈ aries|zodiac ram
♉ taurus|zodiac bull
♊ gemini|zodiac twins
♋ cancer|zodiac crab
♌ leo|zodiac lion
♍ virgo|zodiac maiden
♎ libra|zodiac scales
♏ scorpio|zodiac sting
♐ sagittarius|zodiac archer
♑ capricorn|zodiac goat
♒ aquarius|zodiac water
♓ pisces|zodiac fish
🔱 trident|fork emblem
`],
];

/** One line of catalogue source into an entry. */
function parseLine(line) {
  const char = [...line][0];
  const [name, keywords = ""] = line.slice(char.length).trim().split("|");
  return {
    char,
    name: name.trim(),
    keywords: keywords.trim().split(/\s+/).filter(Boolean),
  };
}

export const EMOJI_GROUPS = GROUP_SOURCE.map(([id, label, icon, source]) => ({
  id,
  label,
  icon,
  emoji: source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseLine),
}));

/** Flat, in catalogue order — search results and RANDOM_BADGE both read this. */
const ALL = EMOJI_GROUPS.flatMap((group) => group.emoji);

const BY_CHAR = new Map(ALL.map((entry) => [entry.char, entry]));

if (BY_CHAR.size !== ALL.length) {
  // A duplicate would give two groups a claim on the same badge and make the
  // picker's selected state ambiguous. tests/emoji.test.mjs is the real guard;
  // this is the one that shouts if a catalogue edit ships without the test.
  console.error(
    `[cousin-congress] emoji catalogue has duplicates: ${ALL.length} entries, ${BY_CHAR.size} unique`
  );
}

/* --------------------------------------------------------------------------
   Search
   -------------------------------------------------------------------------- */

/**
 * Match strength, highest first. A whole keyword outranks a name that merely
 * contains the word, which is why "ball" offers the football before the rice
 * ball and the balloon: children search for the thing, not for the spelling,
 * and the keywords are where the thing is recorded.
 */
const SCORE = {
  nameExact: 100,
  keywordExact: 92,
  nameWordExact: 90,
  namePrefix: 70,
  nameWordPrefix: 60,
  keywordPrefix: 50,
  nameInfix: 30,
  keywordInfix: 20,
};

function scoreToken(entry, token) {
  const name = entry.name;
  if (name === token) return SCORE.nameExact;

  const words = name.split(" ");
  if (entry.keywords.includes(token)) return SCORE.keywordExact;
  if (words.includes(token)) return SCORE.nameWordExact;
  if (name.startsWith(token)) return SCORE.namePrefix;
  if (words.some((word) => word.startsWith(token))) return SCORE.nameWordPrefix;
  if (entry.keywords.some((word) => word.startsWith(token))) return SCORE.keywordPrefix;
  if (name.includes(token)) return SCORE.nameInfix;
  if (entry.keywords.some((word) => word.includes(token))) return SCORE.keywordInfix;
  return 0;
}

/**
 * Rank the catalogue against a query. Every whitespace-separated token has to
 * match something, so "red apple" narrows rather than widens; an empty query
 * returns nothing, because the picker shows the browsable groups instead.
 */
export function searchEmoji(query, limit = 60) {
  const tokens = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return [];

  const hits = [];
  ALL.forEach((entry, index) => {
    let total = 0;
    for (const token of tokens) {
      const score = scoreToken(entry, token);
      if (!score) return;
      total += score;
    }
    hits.push({ entry, total, index });
  });

  hits.sort((a, b) => b.total - a.total || a.index - b.index);
  return hits.slice(0, Math.max(0, limit)).map((hit) => hit.entry);
}

/** Look a badge up, e.g. to show its name beside a member's avatar. */
export const emojiName = (char) => BY_CHAR.get(char)?.name ?? "";

/**
 * A suggestion for a cousin who has just been enrolled. Uses the crypto RNG
 * when there is one purely so that two children signing up side by side are
 * less likely to be offered the same badge; nothing here is a secret.
 */
export function RANDOM_BADGE() {
  const random = globalThis.crypto?.getRandomValues
    ? crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32
    : Math.random();
  return ALL[Math.floor(random * ALL.length)].char;
}

/* --------------------------------------------------------------------------
   Picker
   -------------------------------------------------------------------------- */

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

let pickerSeq = 0;

/**
 * How many options sit in a row, read back from the grid the browser actually
 * laid out rather than assumed from a breakpoint. Up and down across a group
 * boundary land approximately rather than exactly — the groups have different
 * final-row widths — which is the accepted cost of not maintaining a parallel
 * geometry model for a grid CSS already knows.
 */
function columnsAround(option) {
  const track = getComputedStyle(option.parentElement).gridTemplateColumns;
  return Math.max(1, track.split(" ").filter(Boolean).length);
}

/**
 * Render a badge picker into `container`.
 *
 * Keyboard is the primary target, not an afterthought: arrows move, Enter or
 * Space picks, Escape backs out, and typing anywhere in the grid falls through
 * to the search box so a child never has to find it first. Focus is managed
 * with a roving tabindex, so the whole grid is a single tab stop.
 *
 * @returns {{destroy: () => void, setValue: (char: string) => void}}
 */
export function mountEmojiPicker(
  container,
  { value = "", onPick, onClose, groups = EMOJI_GROUPS, limit = 120 } = {}
) {
  if (!container) throw new Error("mountEmojiPicker needs a container element.");

  const uid = `emoji-picker-${(pickerSeq += 1)}`;
  let selected = value;
  let items = [];
  let active = 0;
  let destroyed = false;

  const root = el("div", "emoji-picker");
  root.id = uid;

  /* Search bar. */
  const bar = el("div", "emoji-picker__bar");
  const label = el("label", "u-visually-hidden", "Search badges");
  label.htmlFor = `${uid}-search`;
  const search = el("input", "input emoji-picker__input");
  search.id = `${uid}-search`;
  search.type = "search";
  search.autocomplete = "off";
  search.spellcheck = false;
  search.placeholder = "Search: cat, pizza, star…";
  search.setAttribute("aria-controls", `${uid}-list`);
  const surprise = el("button", "btn btn--ghost btn--sm emoji-picker__surprise", "🎲 Surprise me");
  surprise.type = "button";
  bar.append(label, search, surprise);

  /* Group shortcuts. Plain buttons that scroll — not tabs, because the panels
     are all on screen at once and calling them tabs would be a lie. */
  const jumps = el("nav", "emoji-picker__jumps");
  jumps.setAttribute("aria-label", "Jump to a group");

  const scroll = el("div", "emoji-picker__scroll");
  const list = el("div", "emoji-picker__list");
  list.id = `${uid}-list`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Badge");
  const empty = el("p", "emoji-picker__empty", "No badges match that. Try another word.");
  empty.hidden = true;
  scroll.append(list, empty);

  const status = el("p", "emoji-picker__status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  root.append(bar, jumps, scroll, status);

  /* ---- option construction ---- */

  const optionFor = (entry) => {
    const option = el("div", "emoji-picker__option");
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(entry.char === selected));
    option.tabIndex = -1;
    option.dataset.char = entry.char;
    option.title = entry.name;
    const glyph = el("span", "emoji-picker__glyph", entry.char);
    glyph.setAttribute("aria-hidden", "true");
    // The visible glyph is decorative; the accessible name is the human one,
    // because "grinning face with smiling eyes" read aloud is not a label a
    // six-year-old is listening for.
    const name = el("span", "u-visually-hidden", entry.name);
    option.append(glyph, name);
    return option;
  };

  const section = (heading, entries) => {
    const wrap = el("div", "emoji-picker__section");
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", heading);
    const title = el("h4", "emoji-picker__heading", heading);
    title.setAttribute("aria-hidden", "true");
    const grid = el("div", "emoji-picker__grid");
    grid.setAttribute("role", "presentation");
    for (const entry of entries) grid.append(optionFor(entry));
    wrap.append(title, grid);
    return wrap;
  };

  /* ---- painting ---- */

  const paint = (query) => {
    list.replaceChildren();
    const term = query.trim();

    if (term) {
      const results = searchEmoji(term, limit);
      if (results.length) list.append(section(`Matches for “${term}”`, results));
      empty.hidden = results.length > 0;
      status.textContent = results.length
        ? `${results.length} badge${results.length === 1 ? "" : "s"} match ${term}.`
        : `Nothing matches ${term}.`;
    } else {
      for (const group of groups) list.append(section(`${group.icon} ${group.label}`, group.emoji));
      empty.hidden = true;
      status.textContent = "";
    }

    items = [...list.querySelectorAll("[role='option']")];
    const chosen = items.findIndex((item) => item.dataset.char === selected);
    setActive(chosen >= 0 ? chosen : 0, false);
  };

  function setActive(index, focus = true) {
    for (const item of items) item.tabIndex = -1;
    active = Math.min(Math.max(index, 0), Math.max(items.length - 1, 0));
    const item = items[active];
    if (!item) return;
    item.tabIndex = 0;
    if (focus) {
      item.focus();
      item.scrollIntoView({ block: "nearest" });
    }
  }

  const applySelection = () => {
    for (const item of items) {
      item.setAttribute("aria-selected", String(item.dataset.char === selected));
    }
  };

  const pick = (char) => {
    if (!char) return;
    selected = char;
    applySelection();
    status.textContent = `${char} ${emojiName(char)} chosen.`;
    onPick?.(char, BY_CHAR.get(char));
  };

  /* ---- events ---- */

  const onSearchInput = () => paint(search.value);

  const onSearchKey = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(active);
    } else if (event.key === "Enter") {
      // Swallowed even when nothing is picked: the picker may well be mounted
      // inside a form, and a stray submit would navigate away mid-choice.
      event.preventDefault();
      // Only a typed query has a "top match" worth taking. With an empty box
      // items[0] is merely whatever the catalogue starts with, and committing
      // that is a badge the child never chose.
      if (search.value.trim() && items[0]) pick(items[0].dataset.char);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (search.value) {
        search.value = "";
        paint("");
      } else {
        close();
      }
    }
  };

  const onListKey = (event) => {
    const key = event.key;
    const at = items.indexOf(event.target.closest("[role='option']"));
    if (at < 0) return;

    const move = (to) => {
      event.preventDefault();
      setActive(to);
    };

    if (key === "ArrowRight") return move(Math.min(at + 1, items.length - 1));
    if (key === "ArrowLeft") return move(Math.max(at - 1, 0));
    if (key === "ArrowDown") return move(Math.min(at + columnsAround(items[at]), items.length - 1));
    if (key === "ArrowUp") {
      const up = at - columnsAround(items[at]);
      // Stepping off the top row is how you get back to the search box.
      if (up < 0) {
        event.preventDefault();
        search.focus();
        return undefined;
      }
      return move(up);
    }
    if (key === "Home") return move(0);
    if (key === "End") return move(items.length - 1);
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      return pick(items[at].dataset.char);
    }
    if (key === "Escape") {
      event.preventDefault();
      if (search.value) {
        search.value = "";
        paint("");
        search.focus();
      } else {
        close();
      }
      return undefined;
    }
    // Anything printable is treated as the start of a search.
    if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      search.value += key;
      search.focus();
      paint(search.value);
    }
    return undefined;
  };

  const onListClick = (event) => {
    const option = event.target.closest("[role='option']");
    if (!option) return;
    setActive(items.indexOf(option));
    pick(option.dataset.char);
  };

  function close() {
    onClose?.();
    // Anyone can listen; nobody has to. The picker does not own the sheet or
    // dialog it may have been mounted inside, so closing is a request.
    container.dispatchEvent(new CustomEvent("emoji-picker-close", { bubbles: true }));
  }

  search.addEventListener("input", onSearchInput);
  search.addEventListener("keydown", onSearchKey);
  list.addEventListener("keydown", onListKey);
  list.addEventListener("click", onListClick);
  surprise.addEventListener("click", () => {
    const char = RANDOM_BADGE();
    search.value = "";
    paint("");
    const index = items.findIndex((item) => item.dataset.char === char);
    if (index >= 0) setActive(index);
    pick(char);
  });

  for (const group of groups) {
    const jump = el("button", "emoji-picker__jump", group.icon);
    jump.type = "button";
    jump.title = group.label;
    jump.setAttribute("aria-label", group.label);
    jump.addEventListener("click", () => {
      if (search.value) {
        search.value = "";
        paint("");
      }
      const index = groups.indexOf(group);
      const target = list.children[index];
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
      const first = target?.querySelector("[role='option']");
      if (first) setActive(items.indexOf(first));
    });
    jumps.append(jump);
  }

  container.replaceChildren(root);
  paint("");

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      search.removeEventListener("input", onSearchInput);
      search.removeEventListener("keydown", onSearchKey);
      list.removeEventListener("keydown", onListKey);
      list.removeEventListener("click", onListClick);
      root.remove();
      items = [];
    },
    setValue(char) {
      selected = char;
      applySelection();
      const index = items.findIndex((item) => item.dataset.char === char);
      if (index >= 0) setActive(index, false);
    },
  };
}

export default EMOJI_GROUPS;
