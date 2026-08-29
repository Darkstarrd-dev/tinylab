// Package web embeds the admin frontend and the default on-disk game set.
package web

import "embed"

// Games embeds the default game plugins served from disk: each top-level
// directory under web/games/ is one game (game.json manifest + entry script).
// At startup the router seeds these into {configDir}/games only when the
// target game directory does not exist yet, so game content on disk can be
// edited or extended without recompiling the binary.
//
//go:embed all:games
var Games embed.FS
