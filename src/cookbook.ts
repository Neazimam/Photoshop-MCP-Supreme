export interface Recipe {
  id: string;
  title: string;
  description: string;
  /** Pass to ps_batch_play as `descriptors`. */
  descriptors?: unknown[];
  /** Pass to ps_run_uxp as `code` (args in ctx.args). */
  code?: string;
  notes?: string;
}

const unit = (u: string, v: number) => ({ _unit: u, _value: v });

/**
 * Starting points, NOT verified against every Photoshop version. Confirm/adjust with
 * ps_record_start -> do it by hand -> ps_record_stop, then save the working version with ps_save_script.
 */
export const RECIPES: Recipe[] = [
  {
    id: 'smart-object',
    title: 'Convert selected layer(s) to a smart object',
    description: 'Equivalent of Layer > Smart Objects > Convert to Smart Object.',
    descriptors: [{ _obj: 'newPlacedLayer' }],
  },
  {
    id: 'select-subject',
    title: 'Select Subject',
    description: 'AI subject selection on the active layer.',
    descriptors: [{ _obj: 'autoCutout', sampleAllLayers: false }],
  },
  {
    id: 'invert-selection',
    title: 'Invert selection',
    description: 'Select > Inverse.',
    descriptors: [{ _obj: 'inverse' }],
  },
  {
    id: 'mask-from-selection',
    title: 'Add layer mask that reveals the current selection',
    description: 'Make a pixel mask on the active layer from the active selection.',
    descriptors: [
      {
        _obj: 'make',
        new: { _class: 'channel' },
        at: { _ref: 'channel', _enum: 'channel', _value: 'mask' },
        using: { _enum: 'userMaskEnabled', _value: 'revealSelection' },
      },
    ],
  },
  {
    id: 'gaussian-blur-filter',
    title: 'Gaussian Blur via filter descriptor (works on selection)',
    description: 'Radius in px. For a whole layer without selection prefer ps_gaussian_blur.',
    descriptors: [{ _obj: 'gaussianBlur', radius: unit('pixelsUnit', 10) }],
  },
  {
    id: 'content-aware-fill',
    title: 'Content-Aware Fill of the current selection',
    description: 'Edit > Fill > Content-Aware.',
    descriptors: [
      {
        _obj: 'fill',
        using: { _enum: 'fillContents', _value: 'contentAware' },
        opacity: unit('percentUnit', 100),
        mode: { _enum: 'blendMode', _value: 'normal' },
      },
    ],
  },
  {
    id: 'stamp-visible',
    title: 'Stamp Visible (merged copy on top)',
    description: 'Creates a new layer containing everything visible, keeping the originals.',
    descriptors: [{ _obj: 'mergeVisible', duplicate: true }],
    notes: 'Select the top layer first.',
  },
  {
    id: 'flatten',
    title: 'Flatten image',
    description: 'Layer > Flatten Image.',
    descriptors: [{ _obj: 'flattenImage' }],
  },
  {
    id: 'drop-shadow',
    title: 'Drop shadow layer style on the active layer',
    description: 'Sets layerEffects.dropShadow on the targeted layer.',
    descriptors: [
      {
        _obj: 'set',
        _target: [
          { _ref: 'property', _property: 'layerEffects' },
          { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
        ],
        to: {
          _obj: 'layerEffects',
          scale: unit('percentUnit', 100),
          dropShadow: {
            _obj: 'dropShadow',
            enabled: true,
            mode: { _enum: 'blendMode', _value: 'multiply' },
            color: { _obj: 'RGBColor', red: 0, grain: 0, blue: 0 },
            opacity: unit('percentUnit', 75),
            useGlobalAngle: true,
            localLightingAngle: unit('angleUnit', 120),
            distance: unit('pixelsUnit', 8),
            chokeMatte: unit('pixelsUnit', 0),
            blur: unit('pixelsUnit', 10),
            noise: unit('percentUnit', 0),
            antiAlias: false,
          },
        },
      },
    ],
    notes: 'If a field is rejected, record the same style by hand and compare descriptors.',
  },
  {
    id: 'play-action',
    title: 'Play a Photoshop Action',
    description: 'Prefer the typed tool ps_play_action.',
    descriptors: [
      {
        _obj: 'play',
        _target: [
          { _ref: 'action', _name: 'ACTION NAME' },
          { _ref: 'actionSet', _name: 'SET NAME' },
        ],
      },
    ],
  },
  {
    id: 'loop-all-layers',
    title: 'Do something to every layer (recursive)',
    description: 'Pattern for bulk edits with ps_run_uxp. Replace the body of visit().',
    code: `const out = [];
function visit(layers) {
  for (const l of layers) {
    if (l.layers && l.layers.length) visit(l.layers);
    else if (l.kind === ctx.constants.LayerKind.TEXT) out.push({ id: l.id, name: l.name });
  }
}
visit(ctx.doc.layers);
return out;`,
  },
  {
    id: 'discover-anything',
    title: 'How to do ANY Photoshop operation',
    description: 'Method for features not covered by a typed tool.',
    notes:
      '1) ps_inspect expr "app.activeDocument" to see what the DOM offers. 2) If the DOM lacks it: ps_record_start, perform the action by hand in Photoshop, ps_record_stop, copy the descriptor into ps_batch_play. 3) Take a ps_snapshot before experimenting; restore if it goes wrong. 4) When it works, ps_save_script so it can be re-run with ps_run_script. 5) Legacy-only features: ps_run_extendscript (Windows).',
  },
];
