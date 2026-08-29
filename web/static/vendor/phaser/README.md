# Phaser (vendored browser bundle)

Classic-script browser bundle for the Demo page game plugins
(`web/static/demo-games.js` lazy-loads it on first game launch; games live on
disk under `{configDir}/games/`, see `docs/gamedemo-progress.md`).

| Field | Value |
|---|---|
| Library | Phaser |
| Version | 4.2.1 |
| Bundle | `phaser.min.js` |
| Source | https://cdn.jsdelivr.net/npm/phaser@4.2.1/dist/phaser.min.js |
| Upstream | https://github.com/phaserjs/phaser |
| License | MIT (see `LICENSE`) |
| Global | `window.Phaser` |

The bundle is the upstream UMD distribution and does not require a module
loader. Phaser v4 (GPU render-node architecture) is used deliberately over the
more battle-tested v3 line — the demo games double as a v4 learning surface.

SHA-256: `66348b1b5141e49b7d5ebbe688cddcb502eab1cb00f21c538686a5b2c5abe4de`
