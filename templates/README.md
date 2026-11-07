# Adding a new Personnel / Entity / Synthetic submission

1. Copy `personnel-template.md`, `entity-template.md`, or `synthetic-template.md`.
2. Rename it to the character's name in lowercase (e.g. `dr.mages.md`, `m-031.md`, `syn-001.md`).
3. Write the bio text below the closing `---`.
4. Add images, profile.png for the profile image, and 1.png, 2.png, etc. for gallery images. Add captions for each image (optional).

Tip: send contributors just the template + this file. They can fill in
frontmatter and write the bio without touching any code.

## Importing a submission from a zip

If you want to import a zip `<slug>.zip` package.
Import it from the repository root instead of unzipping it by hand:

```sh
npm run import-submission -- ~/Downloads/<slug>.zip
```

The script checks that every file goes to an expected place, that images really are
images, and that the markdown contains no HTML or script links. It refuses to replace
existing pages; if the submission is meant to update one, rerun with `--overwrite`.
Review the result with `git status` and `git diff` before committing.
