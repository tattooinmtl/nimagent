// NimAgent extension: procedural Three.js game-model generation.
// Creates lightweight model modules that are easy to use in browser games.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(__dirname, "..");
const PROJECTS_ROOT = path.join(INSTALL_ROOT, "NimProjects");

const STYLE_PRESETS = {
  pixel: {
    palette: ["0x6ee16a", "0x3a9d5d", "0xffd166", "0xe85d75", "0x293241"],
    notes: "blocky voxel silhouettes, crisp square parts, chunky readable forms",
  },
  fantasy: {
    palette: ["0x8fbf6f", "0x7a5c45", "0xd6a84f", "0x6e5dd8", "0x32405f"],
    notes: "stone, wood, banners, crystals, runes, warm torch-like accents",
  },
  techno: {
    palette: ["0x111827", "0x00d4ff", "0x79ff4d", "0xff3fb4", "0xffb000"],
    notes: "emissive strips, pylons, drones, holograms, shield rings",
  },
  medieval: {
    palette: ["0x777b82", "0x5b3d2e", "0xb08a4a", "0xa63d40", "0x20242a"],
    notes: "timber, iron, stone bases, banners, siege-machine shapes",
  },
  scifi: {
    palette: ["0x0b1020", "0x74f7ff", "0x9b8cff", "0xff6b35", "0xdce6f2"],
    notes: "sleek shells, fins, glowing cores, antennae, modular panels",
  },
  horror: {
    palette: ["0x18151f", "0x5f233f", "0x9a031e", "0x2d6a4f", "0xd8c99b"],
    notes: "asymmetric silhouettes, spikes, ribs, eerie glow, low saturation",
  },
  toy: {
    palette: ["0xffcf56", "0xff6b6b", "0x4ecdc4", "0x5567ff", "0xf7fff7"],
    notes: "rounded toy-like shapes, bright materials, readable chunky details",
  },
  lowpoly: {
    palette: ["0x80b918", "0xf4a261", "0x457b9d", "0xe76f51", "0x2b2d42"],
    notes: "simple faceted geometry, clean silhouettes, minimal part count",
  },
};

const TYPE_PARTS = {
  tower: ["base", "shaft", "head", "barrel", "range ring", "accent core"],
  enemy: ["body", "head", "legs", "armor plate", "eye", "health anchor"],
  boss: ["core body", "shoulders", "weapon pods", "armor crown", "weak point", "phase rings"],
  prop: ["base", "stem", "cap", "accent", "shadow pad"],
  projectile: ["core", "trail", "impact marker"],
  tile: ["ground slab", "edge trim", "marker", "hover plate"],
};

function slugify(name = "Model") {
  const cleaned = String(name)
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return cleaned || "Model";
}

function camel(name) {
  const s = slugify(name);
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function safeProjectName(name = "ModelLab") {
  return slugify(name || "ModelLab");
}

function resolveProjectModelPath(projectName, modelName) {
  const project = safeProjectName(projectName);
  const file = `${camel(modelName)}.js`;
  const full = path.resolve(PROJECTS_ROOT, project, "src", "models", file);
  const rel = path.relative(PROJECTS_ROOT, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("model path escapes NimProjects");
  return { project, full, rel: path.relative(INSTALL_ROOT, full) };
}

function findModelPath(projectName, modelName) {
  const direct = resolveProjectModelPath(projectName, modelName);
  if (fs.existsSync(direct.full)) return direct;

  const project = safeProjectName(projectName || "ModelLab");
  const modelsDir = path.resolve(PROJECTS_ROOT, project, "src", "models");
  if (!fs.existsSync(modelsDir)) throw new Error(`models directory not found: ${path.relative(INSTALL_ROOT, modelsDir)}`);

  const wanted = String(modelName || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const files = fs.readdirSync(modelsDir).filter((file) => file.endsWith(".js"));
  const matches = files.filter((file) => file.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(wanted));
  if (matches.length === 1) {
    const full = path.join(modelsDir, matches[0]);
    return { project, full, rel: path.relative(INSTALL_ROOT, full) };
  }
  if (matches.length > 1) throw new Error(`ambiguous model name "${modelName}": ${matches.join(", ")}`);
  throw new Error(`model not found: ${modelName} in ${path.relative(INSTALL_ROOT, modelsDir)}`);
}

function materialLines(preset) {
  const [primary, secondary, accent, danger, dark] = preset.palette;
  return [
    `  const primary = new THREE.MeshStandardMaterial({ color: ${primary}, roughness: 0.72, metalness: 0.08 });`,
    `  const secondary = new THREE.MeshStandardMaterial({ color: ${secondary}, roughness: 0.82, metalness: 0.04 });`,
    `  const accent = new THREE.MeshStandardMaterial({ color: ${accent}, roughness: 0.45, metalness: 0.18, emissive: ${accent}, emissiveIntensity: 0.08 });`,
    `  const danger = new THREE.MeshStandardMaterial({ color: ${danger}, roughness: 0.55, metalness: 0.12 });`,
    `  const dark = new THREE.MeshStandardMaterial({ color: ${dark}, roughness: 0.9, metalness: 0.02 });`,
  ].join("\n");
}

function modelBody(type) {
  const kind = String(type || "tower").toLowerCase();
  if (kind === "enemy") {
    return [
      `  add("body", new THREE.SphereGeometry(0.48, 10, 8), primary, [0, 0.52, 0], [1.18, 0.82, 1]);`,
      `  add("head", new THREE.BoxGeometry(0.42, 0.34, 0.36), secondary, [0, 1.02, 0.08]);`,
      `  add("eye", new THREE.BoxGeometry(0.12, 0.08, 0.04), accent, [-0.11, 1.05, 0.27]);`,
      `  add("eye", new THREE.BoxGeometry(0.12, 0.08, 0.04), accent, [0.11, 1.05, 0.27]);`,
      `  add("leftLeg", new THREE.CylinderGeometry(0.08, 0.1, 0.42, 6), dark, [-0.2, 0.2, 0.08]);`,
      `  add("rightLeg", new THREE.CylinderGeometry(0.08, 0.1, 0.42, 6), dark, [0.2, 0.2, 0.08]);`,
    ].join("\n");
  }
  if (kind === "boss") {
    return [
      `  add("core", new THREE.BoxGeometry(1.4, 1.0, 1.2), primary, [0, 0.75, 0]);`,
      `  add("leftShoulder", new THREE.BoxGeometry(0.55, 0.5, 0.8), secondary, [-0.95, 0.85, 0]);`,
      `  add("rightShoulder", new THREE.BoxGeometry(0.55, 0.5, 0.8), secondary, [0.95, 0.85, 0]);`,
      `  add("weakPoint", new THREE.SphereGeometry(0.24, 16, 10), danger, [0, 1.08, 0.62]);`,
      `  add("crown", new THREE.ConeGeometry(0.62, 0.55, 5), accent, [0, 1.55, 0], [0, Math.PI / 5, 0]);`,
      `  add("phaseRing", new THREE.TorusGeometry(0.95, 0.035, 8, 32), accent, [0, 0.78, 0], [Math.PI / 2, 0, 0]);`,
    ].join("\n");
  }
  if (kind === "projectile") {
    return [
      `  add("core", new THREE.SphereGeometry(0.16, 12, 8), accent, [0, 0, 0]);`,
      `  add("trail", new THREE.ConeGeometry(0.11, 0.52, 8), danger, [0, 0, -0.34], [Math.PI / 2, 0, 0]);`,
    ].join("\n");
  }
  if (kind === "tile") {
    return [
      `  add("slab", new THREE.BoxGeometry(1, 0.12, 1), primary, [0, 0, 0]);`,
      `  add("trim", new THREE.BoxGeometry(0.88, 0.04, 0.88), secondary, [0, 0.08, 0]);`,
      `  add("marker", new THREE.TorusGeometry(0.36, 0.018, 6, 24), accent, [0, 0.13, 0], [Math.PI / 2, 0, 0]);`,
    ].join("\n");
  }
  if (kind === "prop") {
    return [
      `  add("base", new THREE.CylinderGeometry(0.32, 0.42, 0.2, 8), dark, [0, 0.1, 0]);`,
      `  add("stem", new THREE.CylinderGeometry(0.13, 0.18, 0.82, 7), secondary, [0, 0.6, 0]);`,
      `  add("cap", new THREE.ConeGeometry(0.5, 0.7, 8), primary, [0, 1.25, 0]);`,
      `  add("accent", new THREE.SphereGeometry(0.12, 8, 6), accent, [0.22, 1.22, 0.22]);`,
    ].join("\n");
  }
  return [
    `  add("base", new THREE.CylinderGeometry(0.52, 0.62, 0.28, 8), dark, [0, 0.14, 0]);`,
    `  add("shaft", new THREE.CylinderGeometry(0.3, 0.38, 0.95, 8), primary, [0, 0.72, 0]);`,
    `  add("head", new THREE.BoxGeometry(0.78, 0.38, 0.62), secondary, [0, 1.32, 0]);`,
    `  add("barrel", new THREE.CylinderGeometry(0.08, 0.1, 0.76, 10), accent, [0, 1.35, 0.56], [Math.PI / 2, 0, 0]);`,
    `  add("rangeRing", new THREE.TorusGeometry(0.72, 0.018, 8, 40), accent, [0, 0.04, 0], [Math.PI / 2, 0, 0]);`,
  ].join("\n");
}

function moduleSource({ model_name, type, style }) {
  const exportName = `create${slugify(model_name)}`;
  const preset = STYLE_PRESETS[String(style || "fantasy").toLowerCase()] || STYLE_PRESETS.fantasy;
  return `// Generated by NimAgent GM Three.js modeler.
// Style notes: ${preset.notes}

import * as THREE from "three";

export function ${exportName}(options = {}) {
  const group = new THREE.Group();
  group.name = options.name || "${slugify(model_name)}";

${materialLines(preset)}

  function add(name, geometry, material, position, rotation = [0, 0, 0], scale = [1, 1, 1]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.scale.set(...scale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }

${modelBody(type)}

  group.userData.modelType = "${String(type || "tower").toLowerCase()}";
  group.userData.style = "${String(style || "fantasy").toLowerCase()}";
  return group;
}
`;
}

function threejsModelGuide({ style = "fantasy", type = "tower", count = 1 } = {}) {
  const key = String(style || "fantasy").toLowerCase();
  const preset = STYLE_PRESETS[key] || STYLE_PRESETS.fantasy;
  const parts = TYPE_PARTS[String(type || "tower").toLowerCase()] || TYPE_PARTS.tower;
  return [
    `Style: ${STYLE_PRESETS[key] ? key : "fantasy"}`,
    `Type: ${type}`,
    `Count: ${count}`,
    `Visual direction: ${preset.notes}`,
    `Palette: ${preset.palette.join(", ")}`,
    "",
    "Recommended parts:",
    ...parts.map((part) => `- ${part}`),
    "",
    "Modeling rules:",
    "- use grouped meshes with named parts",
    "- keep silhouettes readable from an isometric camera",
    "- use simple geometry first: Box, Cylinder, Cone, Sphere, Torus",
    "- keep materials shared within a model family",
    "- expose one create<ModelName>(options) function per model file",
    "- put generated files in NimProjects/<project-name>/src/models/",
  ].join("\n");
}

function createThreejsModelModule(args = {}) {
  const modelName = args.model_name || args.name || "TowerModel";
  const type = args.type || "tower";
  const style = args.style || "fantasy";
  const projectName = args.project_name || "ModelLab";
  const { full, rel } = resolveProjectModelPath(projectName, modelName);
  const source = moduleSource({ model_name: modelName, type, style });
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, source, "utf8");
  return [
    `Created ${rel}`,
    `Export: create${slugify(modelName)}`,
    `Type: ${type}`,
    `Style: ${style}`,
  ].join("\n");
}

function parseAddCalls(source) {
  const calls = [];
  const re = /^\s*add\("([^"]+)",\s*new THREE\.([A-Za-z0-9_]+)\((.*?)\),\s*([A-Za-z0-9_]+),\s*(\[[^\]]*\])(?:,\s*(\[[^\]]*\]))?(?:,\s*(\[[^\]]*\]))?\);/gm;
  let match;
  while ((match = re.exec(source)) !== null) {
    calls.push({
      name: match[1],
      geometry: match[2],
      geometryArgs: match[3],
      material: match[4],
      position: match[5],
      rotation: match[6] || "[0, 0, 0]",
      scale: match[7] || "[1, 1, 1]",
      line: match[0].trim(),
    });
  }
  return calls;
}

function inspectThreejsModelModule({ project_name = "ModelLab", model_name } = {}) {
  if (!model_name) throw new Error("model_name is required");
  const { full, rel } = findModelPath(project_name, model_name);
  const source = fs.readFileSync(full, "utf8");
  const exportMatch = source.match(/export function\s+([A-Za-z0-9_]+)/);
  const typeMatch = source.match(/group\.userData\.modelType\s*=\s*"([^"]+)"/);
  const styleMatch = source.match(/group\.userData\.style\s*=\s*"([^"]+)"/);
  const scaleMatch = source.match(/group\.scale\.set\(([^)]+)\);/);
  const materials = [...source.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*new THREE\.MeshStandardMaterial\(\{\s*color:\s*([^,\s}]+)/g)]
    .map((m) => `${m[1]}=${m[2]}`);
  const parts = parseAddCalls(source);
  return [
    `File: ${rel}`,
    `Export: ${exportMatch?.[1] || "(unknown)"}`,
    `Type: ${typeMatch?.[1] || "(unknown)"}`,
    `Style: ${styleMatch?.[1] || "(unknown)"}`,
    `Group scale: ${scaleMatch?.[1] || "1, 1, 1"}`,
    "",
    "Materials:",
    ...(materials.length ? materials.map((m) => `- ${m}`) : ["- (none found)"]),
    "",
    "Parts:",
    ...(parts.length ? parts.map((p) => `- ${p.name}: ${p.geometry} material=${p.material} position=${p.position} rotation=${p.rotation} scale=${p.scale}`) : ["- (none found)"]),
  ].join("\n");
}

function primitiveGeometry(kind = "box", args = []) {
  const k = String(kind || "box").toLowerCase();
  const nums = Array.isArray(args) ? args.map(Number).filter((n) => Number.isFinite(n)) : [];
  if (k === "sphere") return `new THREE.SphereGeometry(${nums[0] ?? 0.2}, ${nums[1] ?? 12}, ${nums[2] ?? 8})`;
  if (k === "cylinder") return `new THREE.CylinderGeometry(${nums[0] ?? 0.16}, ${nums[1] ?? nums[0] ?? 0.18}, ${nums[2] ?? 0.5}, ${nums[3] ?? 8})`;
  if (k === "cone") return `new THREE.ConeGeometry(${nums[0] ?? 0.25}, ${nums[1] ?? 0.6}, ${nums[2] ?? 8})`;
  if (k === "torus") return `new THREE.TorusGeometry(${nums[0] ?? 0.35}, ${nums[1] ?? 0.03}, ${nums[2] ?? 8}, ${nums[3] ?? 32})`;
  return `new THREE.BoxGeometry(${nums[0] ?? 0.4}, ${nums[1] ?? 0.4}, ${nums[2] ?? 0.4})`;
}

function vectorLiteral(value, fallback = [0, 0, 0]) {
  const arr = Array.isArray(value) ? value : fallback;
  const nums = arr.slice(0, 3).map(Number).map((n, i) => Number.isFinite(n) ? n : fallback[i]);
  while (nums.length < 3) nums.push(fallback[nums.length]);
  return `[${nums.join(", ")}]`;
}

function replaceMaterialColor(source, material, color) {
  const mat = String(material || "").trim();
  const value = String(color || "").trim();
  if (!mat || !value) throw new Error("material and color are required for set_material_color");
  const re = new RegExp(`(const\\s+${mat}\\s*=\\s*new THREE\\.MeshStandardMaterial\\(\\{\\s*color:\\s*)[^,\\s}]+`);
  if (!re.test(source)) throw new Error(`material not found: ${mat}`);
  return source.replace(re, `$1${value}`);
}

function replacePartAddLine(source, partName, editLine) {
  const escaped = String(partName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^(\\s*)add\\("${escaped}",[^\\n]*\\);`, "m");
  if (!re.test(source)) throw new Error(`part not found: ${partName}`);
  return source.replace(re, (_line, indent) => indent + editLine.trim());
}

function editPartVector(source, partName, field, value) {
  const parts = parseAddCalls(source);
  const part = parts.find((p) => p.name === partName);
  if (!part) throw new Error(`part not found: ${partName}`);
  const position = field === "position" ? vectorLiteral(value, [0, 0, 0]) : part.position;
  const rotation = field === "rotation" ? vectorLiteral(value, [0, 0, 0]) : part.rotation;
  const scale = field === "scale" ? vectorLiteral(value, [1, 1, 1]) : part.scale;
  const next = `add("${part.name}", new THREE.${part.geometry}(${part.geometryArgs}), ${part.material}, ${position}, ${rotation}, ${scale});`;
  return replacePartAddLine(source, partName, next);
}

function editThreejsModelModule(args = {}) {
  const { project_name = "ModelLab", model_name, operation = "inspect" } = args;
  if (!model_name) throw new Error("model_name is required");
  if (operation === "inspect") return inspectThreejsModelModule({ project_name, model_name });

  const target = findModelPath(project_name, model_name);
  let source = fs.readFileSync(target.full, "utf8");
  const op = String(operation).toLowerCase();

  if (op === "set_group_scale") {
    const scale = vectorLiteral(args.scale, [1, 1, 1]).slice(1, -1);
    if (/group\.scale\.set\([^)]+\);/.test(source)) {
      source = source.replace(/group\.scale\.set\([^)]+\);/, `group.scale.set(${scale});`);
    } else {
      source = source.replace(/\n\s*return group;/, `\n  group.scale.set(${scale});\n  return group;`);
    }
  } else if (op === "set_material_color") {
    source = replaceMaterialColor(source, args.material, args.color);
  } else if (op === "set_part_position") {
    source = editPartVector(source, args.part, "position", args.position);
  } else if (op === "set_part_rotation") {
    source = editPartVector(source, args.part, "rotation", args.rotation);
  } else if (op === "set_part_scale") {
    source = editPartVector(source, args.part, "scale", args.scale);
  } else if (op === "rename_part") {
    if (!args.part || !args.new_name) throw new Error("part and new_name are required for rename_part");
    source = replacePartAddLine(source, args.part, parseAddCalls(source).find((p) => p.name === args.part).line.replace(`"${args.part}"`, `"${args.new_name}"`));
  } else if (op === "remove_part") {
    if (!args.part) throw new Error("part is required for remove_part");
    const escaped = String(args.part).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^\\s*add\\("${escaped}",[^\\n]*\\);\\n?`, "m");
    if (!re.test(source)) throw new Error(`part not found: ${args.part}`);
    source = source.replace(re, "");
  } else if (op === "add_part") {
    if (!args.part) throw new Error("part is required for add_part");
    const geometry = primitiveGeometry(args.primitive, args.geometry_args);
    const material = args.material || "accent";
    const line = `  add("${args.part}", ${geometry}, ${material}, ${vectorLiteral(args.position)}, ${vectorLiteral(args.rotation)}, ${vectorLiteral(args.scale, [1, 1, 1])});`;
    source = source.replace(/\n\s*group\.userData\.modelType\s*=/, `\n${line}\n\n  group.userData.modelType =`);
  } else if (op === "set_user_data") {
    if (!args.key || args.value === undefined) throw new Error("key and value are required for set_user_data");
    const key = String(args.key).replace(/[^A-Za-z0-9_]/g, "");
    const value = JSON.stringify(args.value);
    const re = new RegExp(`group\\.userData\\.${key}\\s*=\\s*[^;]+;`);
    if (re.test(source)) source = source.replace(re, `group.userData.${key} = ${value};`);
    else source = source.replace(/\n\s*return group;/, `\n  group.userData.${key} = ${value};\n  return group;`);
  } else {
    throw new Error(`unknown operation: ${operation}`);
  }

  fs.writeFileSync(target.full, source, "utf8");
  return [`Edited ${target.rel}`, `Operation: ${operation}`, "", inspectThreejsModelModule({ project_name, model_name })].join("\n");
}

export default {
  name: "threejs-3d-modeler",
  tools: [
    {
      type: "function",
      function: {
        name: "threejs_model_guide",
        description: "Return practical guidance for making a Three.js procedural game model.",
        parameters: {
          type: "object",
          properties: {
            style: { type: "string", description: "pixel, fantasy, techno, medieval, scifi, horror, toy, lowpoly" },
            type: { type: "string", description: "tower, enemy, boss, prop, projectile, tile" },
            count: { type: "integer", description: "Number of matching models the user wants." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_threejs_model_module",
        description: "Create a reusable procedural Three.js model module in NimProjects/<project>/src/models/.",
        parameters: {
          type: "object",
          properties: {
            project_name: { type: "string", description: "Project folder under NimProjects." },
            model_name: { type: "string", description: "Model name, e.g. Frost Tower or Shield Tank." },
            type: { type: "string", description: "tower, enemy, boss, prop, projectile, tile" },
            style: { type: "string", description: "pixel, fantasy, techno, medieval, scifi, horror, toy, lowpoly" },
          },
          required: ["project_name", "model_name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "inspect_threejs_model_module",
        description: "Inspect one generated Three.js model module and list its materials, parts, transforms, type, and style.",
        parameters: {
          type: "object",
          properties: {
            project_name: { type: "string", description: "Project folder under NimProjects." },
            model_name: { type: "string", description: "Model name or partial model file name." },
          },
          required: ["project_name", "model_name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_threejs_model_module",
        description: "Edit one generated Three.js model module without touching the rest of the project.",
        parameters: {
          type: "object",
          properties: {
            project_name: { type: "string", description: "Project folder under NimProjects." },
            model_name: { type: "string", description: "Model name or partial model file name." },
            operation: {
              type: "string",
              description: "inspect, set_group_scale, set_material_color, set_part_position, set_part_rotation, set_part_scale, rename_part, remove_part, add_part, set_user_data",
            },
            material: { type: "string", description: "Material name, e.g. primary, secondary, accent, danger, dark." },
            color: { type: "string", description: "Hex color literal, e.g. 0xff00aa." },
            part: { type: "string", description: "Named model part to edit." },
            new_name: { type: "string", description: "New part name for rename_part." },
            primitive: { type: "string", description: "box, sphere, cylinder, cone, torus for add_part." },
            geometry_args: { type: "array", items: { type: "number" }, description: "Primitive constructor numbers." },
            position: { type: "array", items: { type: "number" }, description: "[x, y, z]." },
            rotation: { type: "array", items: { type: "number" }, description: "[x, y, z] radians." },
            scale: { type: "array", items: { type: "number" }, description: "[x, y, z]." },
            key: { type: "string", description: "userData key for set_user_data." },
            value: { description: "userData value for set_user_data." },
          },
          required: ["project_name", "model_name", "operation"],
        },
      },
    },
  ],
  impl: {
    threejs_model_guide: threejsModelGuide,
    create_threejs_model_module: createThreejsModelModule,
    inspect_threejs_model_module: inspectThreejsModelModule,
    edit_threejs_model_module: editThreejsModelModule,
  },
};
