# Vendored libraries

Copied unchanged from the npm packages, so the site uses them without a build
step and without loading them from a CDN.

| Folder | Package | Version | Licence |
|---|---|---|---|
| `leaflet/` | [leaflet](https://www.npmjs.com/package/leaflet) | 1.9.4 | BSD-2-Clause (`LICENSE`) |
| `leaflet.markercluster/` | [leaflet.markercluster](https://www.npmjs.com/package/leaflet.markercluster) | 1.5.3 | MIT (`LICENSE`) |

Taken from each package's `dist/` folder: `leaflet.js`, `leaflet.css` and
`images/` for Leaflet; `leaflet.markercluster.js`, `MarkerCluster.css` and
`MarkerCluster.Default.css` for the cluster plugin.

To upgrade, copy the same files from the new release's `dist/` folder, keep the
licence, and update the version above.
