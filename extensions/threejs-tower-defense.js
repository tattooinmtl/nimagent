// NimAgent extension: Three.js tower-defense guidance and style presets.
// Loaded via nimagent.config.json -> extensions.

const STYLE_PRESETS = {
  pixel: {
    vibe: "Voxel-like, readable, low-poly, crisp, bright, and tile-forward.",
    palette: "grass green, dirt brown, sky blue, coin gold, red hit flashes",
    towers: ["cube turret", "block cannon", "voxel mage", "pixel tesla coil", "block mortar"],
    enemies: ["slime cube", "skull block", "beetle brick", "bat wedge", "armored cube boss"],
    props: ["block trees", "cube rocks", "coin pickups", "tile highlights"],
  },
  fantasy: {
    vibe: "Stone roads, glowing crystals, runes, banners, torches, and readable magic FX.",
    palette: "moss, stone, amber, royal red, mana blue",
    towers: ["archer tower", "mage spire", "cannon keep", "frost crystal", "druid grove"],
    enemies: ["goblin runner", "armored knight", "wolf pack", "wraith", "dragon boss"],
    props: ["castle gate", "ruins", "mushrooms", "trees", "braziers", "magic sigils"],
  },
  techno: {
    vibe: "Grid floor, emissive strips, holograms, drones, lasers, and shield rings.",
    palette: "graphite, cyan, lime, magenta, warning orange",
    towers: ["laser prism", "railgun pylon", "drone bay", "pulse tower", "EMP dish"],
    enemies: ["crawler bot", "hover drone", "shield tank", "nanite swarm", "core boss"],
    props: ["neon path rails", "hex tiles", "data pillars", "reactor cores"],
  },
  medieval: {
    vibe: "Fortified walls, timber, iron, flags, cobblestone paths, and siege machines.",
    palette: "stone gray, timber brown, iron, muted banners, fire orange",
    towers: ["ballista", "catapult", "watchtower", "oil cauldron", "crossbow turret"],
    enemies: ["footman", "shield bearer", "cavalry", "siege ram", "warlord boss"],
    props: ["walls", "tents", "crates", "hay bales", "banners", "torches"],
  },
};

function slugifyProjectName(name = "TowerDefense") {
  const cleaned = String(name)
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return cleaned || "TowerDefense";
}

function formatList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function towerDefenseGuide({ style = "fantasy", project_name = "TowerDefense", include_structure = true } = {}) {
  const key = String(style || "fantasy").toLowerCase();
  const preset = STYLE_PRESETS[key] || STYLE_PRESETS.fantasy;
  const slug = slugifyProjectName(project_name);
  const sections = [
    `Project folder: NimProjects/${slug}/`,
    `Style: ${STYLE_PRESETS[key] ? key : "fantasy"}`,
    `Visual direction: ${preset.vibe}`,
    `Palette: ${preset.palette}`,
    "",
    "Tower set:",
    formatList(preset.towers),
    "",
    "Enemy set:",
    formatList(preset.enemies),
    "",
    "Prop/model set:",
    formatList(preset.props),
    "",
    "Gameplay checklist:",
    formatList([
      "visible path from spawn to base",
      "buildable tiles distinct from path and blocked tiles",
      "at least 3 tower roles: starter damage, crowd control, boss killer",
      "at least 3 enemy roles: fast, armored, swarm, plus one boss",
      "waves, lives, currency, build cost, sell/refund, upgrades",
      "range preview, placement ghost, valid/invalid tile feedback",
      "win, lose, and restart states",
    ]),
    "",
    "Three.js implementation tips:",
    formatList([
      "use Raycaster for tile picking and tower selection",
      "use InstancedMesh for repeated enemies, tiles, props, and particles",
      "use simple geometry before imported models",
      "pool projectile and particle meshes instead of recreating them every shot",
      "separate game state from mesh rendering",
      "cap renderer pixel ratio with Math.min(window.devicePixelRatio, 2)",
      "keep the camera angled so the full board and tower heights are readable",
    ]),
  ];

  if (include_structure !== false) {
    sections.push(
      "",
      "Recommended Vite structure:",
      formatList([
        "package.json",
        "index.html",
        "src/main.js",
        "src/style.css",
        "src/game/map.js",
        "src/game/towers.js",
        "src/game/enemies.js",
        "src/game/waves.js",
      ])
    );
  }

  return sections.join("\n");
}

export default {
  name: "threejs-tower-defense",
  tools: [
    {
      type: "function",
      function: {
        name: "threejs_tower_defense_guide",
        description: "Return Three.js tower-defense build guidance, style presets, model sets, and gameplay tips.",
        parameters: {
          type: "object",
          properties: {
            style: {
              type: "string",
              description: "Style preset: pixel, fantasy, techno, medieval.",
            },
            project_name: {
              type: "string",
              description: "Project name used to suggest NimProjects/<project-name>/.",
            },
            include_structure: {
              type: "boolean",
              description: "Include recommended Vite/Three.js file structure. Default true.",
            },
          },
        },
      },
    },
  ],
  impl: {
    threejs_tower_defense_guide: towerDefenseGuide,
  },
};
