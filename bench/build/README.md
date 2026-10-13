# Rebuilding the benchmark site

`bench/site/`, `bench/ground-truth.json` and `bench/GROUND_TRUTH.md` are generated:

```bash
node bench/build/build.mjs bench          # HTML, robots, sitemaps, llms.txt, .well-known, ground truth
python3 bench/build/images.py bench/site  # images (needs Pillow), deterministic seed
node bench/verify-ground-truth.mjs        # checks every planted defect manifests
```

The output is committed, so you only need this to change the site.
