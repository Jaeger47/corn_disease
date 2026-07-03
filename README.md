# CornLeaf

https://buksu-corn-ai.netlify.app/menu/corn_mang

Private, on-device corn leaf disease screening. The production app downloads
its versioned ONNX model from this public repository through jsDelivr, then
runs inference locally in the browser. Photos are not uploaded.

## Deployment

Netlify is configured by `netlify.toml` to publish only `site/`. The model stays
outside that directory at `models/maize-disease-efficientnetb0.onnx` and is
served from the immutable `v1.0.0` Git tag through jsDelivr.

For local development, serve the repository root and open `/site/` so the app
uses the local model automatically.
