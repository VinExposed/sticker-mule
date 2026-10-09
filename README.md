# Peel

A sticker playground in the browser. Open a pack, grab a corner, peel one off and slap it onto a notebook.

![Peel: a notebook with stickers and a half-used sticker sheet](docs/hero.jpg)

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # unit tests for the peel and wrap geometry
npm run build   # static site in dist/
```

## What you can do

- **Peel.** Press near a sticker's edge and drag across it. The sticker curls back from that exact spot and the glossy liner shows underneath. Pull away from the sticker instead and it lifts until the tension pops it free. Grab it in the middle and it plucks straight off.
- **Stick.** Carry it anywhere. It swings on the point you're holding and leans into the direction you move. Scroll or press Q/E to spin it, then let go and it slaps down. Stickers stack. If one hangs off the notebook it wraps over the edge.
- **Holo.** Three of the characters are holographic. Move the mouse, drag the desk to tilt the view, or tilt your phone, and the foil shifts colour.
- **Make your own.** Draw one, or drop in an image (plain backgrounds are removed automatically). Pick gloss, matte or holo, and it gets a die-cut border and lands in your hand.
- **Keep it.** The notebook saves itself locally. *Share* puts the whole composition, custom art included, into a link. *Save image* downloads a PNG.

## How it works

### The peel model (`src/peel/model.ts`)

A sticker is treated as an inextensible sheet. A peel is fully described by a fold line (direction `d` and position `f`), a curl radius `r` and a wrap angle `θ`:

- points on the stuck side of the fold stay put;
- points past the fold wrap around a cylinder of radius `r` for up to `θ` radians;
- after that the sheet carries on as a straight flap.

Arc length is preserved, so the sticker never stretches (the tests check this numerically).

The harder part is the inverse problem: given where the pointer is, find the fold so that the point you grabbed lands under the cursor.

- **Folding back over the sticker** has an exact answer. The grabbed point travels `s − r·sin(s/r)` along the peel direction while it's on the curl, which is solved with guarded Newton iteration, and `(reach + πr)/2` once the flap lies flat on top.
- **Pulling away from the sticker** has no answer for an inextensible sheet. Instead the flap lifts and builds tension, and the sticker pops free when the tension passes a threshold. Real vinyl behaves the same way.

The pointer target is spring-smoothed and the fold direction is blended, so switching between the two cases never snaps. Releasing early sends the target back through an underdamped spring, so the flap slaps down.

Once a sticker is free, it's carried by the exact point you were holding (`pivot · tilt · yaw · translate(−grab)`, using the grab point's *curled* position). That's why a freshly popped flap unfolds around your fingers instead of jumping.

### Wrapping over edges (`src/peel/wrap.ts`)

Stickers that hang past the notebook's edge fold over it, run down the side and continue onto the desk. Each point's distance from the edge is kept the same, so the sticker doesn't stretch here either.

### Hit testing and peel direction (`src/stickers/factory.ts`)

Each sticker's die-cut silhouette is rasterised to a coarse mask. A chamfer distance transform of that mask gives two things at any point:

- the distance to the edge, which decides whether you're peeling or plucking;
- the gradient, which points inward and so gives the natural peel direction.

The gradient sends a corner grab along the bisector and an edge grab straight in. Picking raycasts the deformed meshes, then checks the hit's UV against the mask, so the transparent part of the quad can't be grabbed.

### Rendering

- **Geometry.** Each sticker is an 84×84 grid deformed on the CPU, and only while it's moving. Stickers at rest cost nothing per frame. The front is a physical material with a clearcoat, sharing its geometry with an adhesive-paper back face.
- **Soft shadows.** `src/scene/pcss.ts` patches three's shadow lookup with percentage-closer soft shadows. A blocker search estimates how high the occluder is and widens the filter to match. A lifted corner gets a tight contact shadow, and a sticker held 3 cm up throws a broad, faint one. The shadow map is only re-rendered when something moves.
- **Holographic foil.** `src/stickers/materials.ts` injects a foil pass into `MeshPhysicalMaterial` before lighting:
  - Voronoi "shattered glass" shards, each a tiny mirror at its own tilt;
  - a spectral tint driven mostly by the reflection vector, so colour follows the viewing angle;
  - a sheen band that slides across;
  - glitter that only flashes when a fleck lines up with your eye.

  Foil is masked per sticker, so the ink and faces stay printed.
- **Generated assets.** Textures, die-cut borders, the kiss-cut sheet (with liner holes and a roughness map for the glossy liner) and all sounds are generated at runtime. The peel crackle is a stream of band-passed noise grains whose density follows the speed of the peel front.
- **Adaptive resolution.** Pixel ratio drops on slow GPUs and recovers on fast ones. A 4K retina frame renders in about 8 ms on an M4.

### Layout

| File | What it owns |
| --- | --- |
| `src/peel/model.ts` | peel geometry and the drag → fold solver (pure, tested) |
| `src/peel/wrap.ts` | wrapping over box edges (pure, tested) |
| `src/stickers/factory.ts` | art → die-cut sticker, masks, distance field |
| `src/stickers/sticker.ts` | per-sticker mesh, pose and deformation |
| `src/stickers/materials.ts` | gloss / matte / holo materials |
| `src/stickers/art.ts` | the ten characters, as SVG |
| `src/playground.ts` | interaction state machine: hover, peel, carry, drop, layering |
| `src/scene/*` | renderer, camera, desk, notebook, sheet, PCSS |
| `src/audio.ts` | synthesized sound |
| `src/persist.ts`, `src/library.ts` | saving, share links, custom stickers |
| `src/ui.ts` | toolbar, sticker maker, hints |

![Close-up of a sticker mid-peel](docs/peel-closeup.jpg)
