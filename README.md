# SwarmUI See-through Extension

A [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI) extension that adds a **See-through** tab for decomposing a single
anime illustration into depth-ordered semantic layers (front/back hair, face, eyes, clothing, limbs, ...) and exporting a
layered **PSD** for Live2D workflows.

It wraps the ComfyUI node pack [jtydhr88/ComfyUI-See-through](https://github.com/jtydhr88/ComfyUI-See-through), which itself
wraps the [See-through](https://github.com/shitagaki-lab/see-through) research project.

## What it does

- Upload one image, click **Decompose**.
- Runs the full pipeline on your ComfyUI backend: LayerDiff (SDXL) layer generation → Marigold depth → post-process
  (left/right splitting, hair clustering) → per-layer PNG export.
- Reports progress per pipeline stage (Layers → Depth → Post-process → Finalize) with live intermediate previews.
- Shows a blended preview and a gallery of every decomposed layer.
- Builds a layered `.psd` (and an optional depth `.psd`) entirely in your browser via [ag-psd](https://github.com/Agamnentzar/ag-psd),
  so nothing extra is sent to any server.
- Exports all layers (color + depth PNGs) plus a geometry `manifest.json` as a single ZIP (built client-side, no dependencies).

## Requirements

- A working ComfyUI backend inside SwarmUI.
- The See-through node pack. The extension registers it as an installable feature — you can install it from the ComfyUI
  backend / installable features UI, or manually clone it into your ComfyUI `custom_nodes`.
- Heavy dependencies (`diffusers`, `bitsandbytes`, ...) and several GB of models auto-downloaded from HuggingFace on first run.
- A GPU with enough VRAM. Use **Quantization = nf4** (~8GB) and/or **Group offload** to reduce VRAM at the cost of speed.

## Install

```
cd SwarmUI/src/Extensions
git clone https://github.com/mrleo1nid/SeeThrough
```

Then run the SwarmUI `update` script (or launch with a `launch-*-dev` script) to rebuild, and restart SwarmUI. A new
**See-through** tab will appear.

## Notes / limitations

- The decomposition is a heavy, single-GPU operation — expect several minutes per image.
- Layer files are read back from the ComfyUI backend's output folder via its `/view` endpoint; the first available ComfyUI
  backend is used.
- PSD/depth-PSD generation happens client-side; large images produce large PSDs.

## Credits

- Nodes: [jtydhr88/ComfyUI-See-through](https://github.com/jtydhr88/ComfyUI-See-through) and the See-through research project.
- PSD writing: [ag-psd](https://github.com/Agamnentzar/ag-psd) (MIT), bundled in `Assets/ag-psd.bundle.js`.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
