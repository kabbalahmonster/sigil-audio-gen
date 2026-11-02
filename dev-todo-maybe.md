
-Drum pattern engine. The score's Euclidean patterns are thin for a flagship kit. A drum-specific generator with fills, turnarounds at section boundaries, hat openings on phrase ends and velocity curves derived from the sigil.

-Transient shaper in the worklet. A proper envelope follower on the drum bus gives real attack and sustain controls, and a better sidechain than the scheduled gain dip.

-Per-bus crushers and filters. One crusher for the kit, one for the voices, so you can destroy the drums without destroying the choir.

-Parallel drum compression. A second, hard-compressed copy of the kit blended back in. This is the standard way to get weight without losing the transient, and it is two nodes.

-Velocity-to-timbre mapping. Hard hits should open filters and lengthen decays, not merely get louder. It is the difference between a sampler and an instrument.

-A proper mixer metering layer. Per-bus peak and RMS, clip indicators, and a master loudness estimate, so the balance work stops being guesswork.

-Sound arc editor. The section curve is fixed in code. A small editable envelope per parameter would make the narrative authored rather than derived.

-Kit sample-free layering from the sigil. Use cube cells as drum bodies, so the kit and the lead share DNA, and a dream changes both together.

-State serialisation v2. One file that holds the sigil, mood, patch, drum options, visual style and mixer scene, so a whole working can be saved, shared and reopened exactly.

---------------

-AudioWorklet voice engine. Move voices and drums into one worklet with a shared voice pool. This is the single biggest stability gain, since it removes most per-note node creation from the main thread.

-Offline render in a Web Worker. Render on a worker-backed context so exports never contend with playback. Today a long render competes with the live scheduler.

-Drum cube editor. Click any of the 16 kits to audition it, and edit its kick, snare and hat values directly.

-Groove and swing by section. Per-section swing and micro-timing, driven by the rite's shape, so the Banishing drags and the Apotheosis pushes.

-Sub-bass voice. A dedicated 808-style bass voice with its own glide and saturation, sharing the kick's tuning.

-Drum pattern variety from the sigil. Generate alternative kick and snare patterns from the sigil's Euclidean rhythms, chosen per dream, in place of the single pattern per song.

-Visual style presets per mood. Each mood suggests a default visual style, so Glacier opens in Bloom and Swarm in Helix.

-Lens-driven kit. Turning the wheel moves through the drum cube, so the kit can be performed live.

-Saved sessions. Store the full state (sigil, dream, patch, drum kit, visual style, section) as one shareable link, which extends the current patch code.

---------------