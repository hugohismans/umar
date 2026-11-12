# Scatter

A virtual label-free microscope: light scattering spectroscopy (LSS) in the browser,
with real Mie theory.

A simulated epithelium of about 3,000 cells hides a precancerous region whose nuclei are
enlarged (about 10 µm instead of 5–6 µm) and crowded. Nothing shows under white light.
Move the probe: the backscattering spectrum oscillates faster where nuclei are larger, and
a least-squares fit against precomputed Mie spectra retrieves their size distribution.
Press **Scan** and the map reveals the lesion.

The technique is the one developed by Lev Perelman's group (Harvard / BIDMC):
Perelman *et al.*, PRL 80, 627 (1998); Backman *et al.*, Nature 406, 35 (2000);
Gurjar *et al.*, Nature Medicine 7, 1245 (2001).

## What is in the box

| Screen | What it does |
|---|---|
| **Microscope** | Tissue view, movable probe, spectrum, retrieved size distribution, raster scan, "reveal histology" ground truth, exposure (photon noise), new random sample |
| **Bench** | A few ideal nuclei, exact Mie recomputed live; sliders for diameter, spread, number, relative index, noise |
| **Learn** | Four animated steps: why a bigger nucleus makes the spectrum oscillate faster |
| **Physics** | The model, its equations, its limits, and the references |

## Physics

- `src/physics/mie.ts`: Lorenz–Mie scattering, a TypeScript port of BHMIE (Bohren & Huffman 1983, Appendix A).
- `src/physics/lss.ts`: polarization-gated backscattering into a 2.5° cone, Mie tables, diffuse background, photon noise.
- `src/physics/fit.ts`: non-negative least-squares inversion against the Mie table (matching pursuit, stopped at the noise floor).
- `src/tissue.ts`: procedural epithelium with a hidden dysplastic region.
- `src/worker.ts`: all of the above runs in a Web Worker.

Unit tests (`npm test`) compare the Mie code with the Bohren & Huffman sample output and
Wiscombe's reference cases to six significant figures, check the Rayleigh and
anomalous-diffraction limits, the optical theorem, the fringe count 2·n·d·Δ(1/λ), and the
accuracy of the inversion on nuclei that are off the table grid and at a different index.

The page "Physics" in the app documents the model and what it leaves out.

## Develop

```sh
npm install
npm run dev      # local server
npm test         # unit tests
npm run build    # static site in dist/
```

The site is fully static (no backend). `.github/workflows/deploy.yml` builds it and
publishes `dist/` to GitHub Pages on every push to `main` (Pages source must be set to
"GitHub Actions" in the repository settings).
