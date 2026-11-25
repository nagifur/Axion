# Adding a new Personnel / Entity / Synthetic submission

1. Copy `personnel-template.md`, `entity-template.md`, or `synthetic-template.md`.
2. Rename it to the character's name in lowercase (e.g. `dr.mages.md`, `m-031.md`, `syn-001.md`).
3. Write the bio text below the closing `---`.
4. Add images, profile.png for the profile image, and 1.png, 2.png, etc. for gallery images. Add captions for each image (optional).

Tip: send contributors just the template + this file. They can fill in
frontmatter and write the bio without touching any code.

## Optional simulation stats

Personnel, entity, and synthetic Markdown files can include a `stats` block in
their frontmatter. All fields are optional; omitted fields use these defaults:

```yaml
stats:
  hp: 100
  stamina: 100
  magic: 0
  hunger: 100
  thirst: 100
```

These are maximum capacities. HP, stamina, and magic start full; hunger and
thirst start at 0 (satisfied), with their maximum meaning an urgent need.
Magic is disabled at 0; set a positive capacity only for magic users.
Other capacities must be positive finite numbers. Unknown stat names are rejected.
The monitoring panel shows live values. So far only HP changes (creature attacks and
swallowing acid lower it, absorbing prey restores it, and zero HP is fatal); the other
stats don't drain yet. Stats reset on a new spawn or page reload and are not saved.
Personnel, contained creatures, and shapeshifting entities currently spawn in
monitoring; synthetic stats are accepted for future use.

## Vore preference in the simulation

In monitoring, `vorePreference` on personnel and entities decides who swallows whom:

- `[Predator]` swallows anyone shorter than themselves, or anyone at all if they are a
  slime or their `height` varies ("Varies", "Variable").
- `[Prey]` does not swallow, except now and then someone at least three times shorter.
- `[Switch]` (or listing both `Predator` and `Prey`) acts as prey when badly hurt and as a
  predator when overpowering the other character.
- `[None]` (the default) and `Non-Vore` take no part: they are never swallowed.

Height therefore matters: use a `height` the simulation can read, such as `5'8"` or
`{{5'8"|1.73 m}}`; an unknown height counts as 1.9 m. Swallowed characters take acid
damage, are digested and absorbed, and leave remains behind. See
[The Vore System](../docs/DEVELOPMENT.md#the-vore-system) for the full rules.

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
