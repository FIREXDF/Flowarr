# Flowarr Plugin SDK

Flowarr plugins are declarative JSON manifests. They add configurable blocks without loading third-party JavaScript or invoking a shell. Before scheduling, each plugin block is compiled into a supported core Flowarr node, so local and remote workers receive a self-contained job snapshot.

Create `plugins/example/flowarr.plugin.json`:

```json
{
  "schemaVersion": 1,
  "id": "example.media",
  "name": "Example media tools",
  "version": "1.0.0",
  "description": "Reusable media transforms.",
  "nodes": [{
    "id": "cinema-crop",
    "label": "Cinema crop",
    "description": "Crop 1080p letterboxing.",
    "category": "Example",
    "expandsTo": "crop",
    "defaults": { "width": 1920, "height": 800, "x": 0, "y": 140 },
    "fields": [{ "key": "height", "label": "Height", "type": "number", "default": 800, "min": 2, "max": 1080 }]
  }]
}
```

Set `FLOWARR_PLUGIN_DIR` to override the default `./plugins` directory. Use `GET /api/plugins` to inspect loaded manifests/errors and `POST /api/plugins/reload` after changing files.

TypeScript authors can use `definePlugin()` from `@flowarr/plugin-sdk` for validation and literal type inference before serializing the manifest.
