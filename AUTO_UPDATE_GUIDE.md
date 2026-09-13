# Zotero MCP Plugin Auto-Update Guide

## 🔄 Auto-Update Configuration

The Zotero MCP plugin is configured for automatic updates through GitHub releases. Here's how it works:

### Update URL Configuration

The plugin's `manifest.json` contains:
```json
{
  "applications": {
    "zotero": {
      "id": "zotero-mcp-plugin@autoagent.my",
      "update_url": "https://github.com/NightWatcher314/zotero-mcp/releases/latest/download/update.json"
    }
  }
}
```

### Update Manifest (`update.json`)

The update manifest follows Zotero's update format:
```json
{
  "addons": {
    "zotero-mcp-plugin@autoagent.my": {
      "updates": [
        {
          "version": "1.2.0",
          "update_link": "https://github.com/NightWatcher314/zotero-mcp/releases/download/v1.2.0/zotero-mcp-plugin-1.2.0.xpi",
          "applications": {
            "zotero": {
              "strict_min_version": "6.999",
              "strict_max_version": "8.*"
            }
          }
        }
      ]
    }
  }
}
```

## 📋 How Auto-Update Works

1. **Version Check**: Zotero periodically checks the `update_url` for version updates
2. **Comparison**: Compares the version in `update.json` with the installed version
3. **Download**: If a newer version is found, downloads the `.xpi` from `update_link`
4. **Installation**: Prompts user to install the update or installs automatically (based on Zotero settings)

## 🚀 Release Process for Auto-Update

### 1. Version Update
```bash
# Update version in package.json
npm version patch  # or minor/major
```

### 2. Maintained Fork Release
This fork currently publishes releases manually; it has no GitHub Actions release workflow.
From `zotero-mcp-plugin/`, run `npm run test:unit`, `npm run prepare-release`, and
`npm run build`. Commit and push the source and version tag, then publish the
versioned XPI and `update.json` to `NightWatcher314/zotero-mcp`.

Verify that the XPI manifest, package version, update link, and supported Zotero
version range agree. Do not publish `update-beta.json` unless its referenced beta
XPI also exists. Compare downloaded release asset hashes with the built files.

### 3. Update URL Resolution
- Plugin checks: `https://github.com/NightWatcher314/zotero-mcp/releases/latest/download/update.json`
- GitHub redirects `latest` to the most recent release
- Users get the newest version automatically

## 🧪 Testing Auto-Update

### Method 1: Version Downgrade Test
1. Install an older version of the plugin
2. Wait for Zotero's automatic update check (or restart Zotero)
3. Check if update notification appears

### Method 2: Manual Update Check
1. In Zotero: `Tools → Add-ons`
2. Click gear icon → "Check for Updates"
3. Should detect if newer version is available

### Method 3: URL Verification
Test the update URL manually:
```bash
curl -L "https://github.com/NightWatcher314/zotero-mcp/releases/latest/download/update.json"
```

Should return the latest version information.

## 🔧 Troubleshooting

### Common Issues

1. **Update not detected**
   - Check Zotero's update frequency settings
   - Verify `update.json` is accessible at the URL
   - Ensure version number format is correct (semantic versioning)

2. **Download fails**
   - Verify `.xpi` file exists in the GitHub release
   - Check file permissions and accessibility
   - Ensure release is not marked as "draft"

3. **Version comparison issues**
   - Ensure version numbers follow semantic versioning (x.y.z)
   - Check that new version is actually higher than installed version

### Debug Steps

1. **Check plugin manifest**:
   ```bash
   # Extract and check manifest from installed .xpi
   unzip -p zotero-mcp-plugin-1.2.0.xpi manifest.json | jq
   ```

2. **Verify update URL**:
   ```bash
   curl -I "https://github.com/NightWatcher314/zotero-mcp/releases/latest/download/update.json"
   ```

3. **Test download link**:
   ```bash
   curl -I "https://github.com/NightWatcher314/zotero-mcp/releases/download/v1.2.0/zotero-mcp-plugin-1.2.0.xpi"
   ```

## 📝 Update Check Frequency

### Stale version after manually replacing an XPI

Prefer installation through Zotero's Add-ons Manager. If a manually replaced XPI
runs new code but the manager still reports the old version, close Zotero normally
and verify that its process has exited. Back up the profile's `addonStartup.json.lz4`
before moving it aside, then relaunch Zotero with `--purgecaches`. Do not edit
`extensions.json` to manufacture a version change. Check the installed XPI hash,
the manager's active version, and a live plugin operation independently.

The MCP status endpoint's server version is not the installed XPI version.

Zotero checks for add-on updates:
- Every 24 hours by default
- On startup if last check was >24 hours ago
- When manually triggered via "Check for Updates"

## 🔒 Security Considerations

- Updates are served over HTTPS
- GitHub provides file integrity and authenticity
- Zotero validates plugin signatures (if signed)
- Users can disable automatic updates in Zotero preferences

## 📚 References

- [Zotero Plugin Development](https://www.zotero.org/support/dev/client_coding/plugin_development)
- [WebExtension Update Manifest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Updates)
- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases)
