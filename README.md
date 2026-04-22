# Architecture Project Skeleton

A project skeleton for a living architecture documentation.

## Development

To generate ToC on top of every document use the following HTML comments:

```html

<!-- toc -->

  * [Reindexing search](#reindexing-search)
- [Self-hosted Documentation](#self-hosted-documentation)
- [Building DOCX](#building-docx)
- [References](#references)

<!-- tocstop -->

```

## How to build and run the project

### Building at the first time

Make sure you have `nvm` (node virtual manager) installed and use the correct version of node.
Install and initiate the project with the following command:

```shell
yarn install
```

### Reindexing search

You have to build first to make sure all content is re-indexed into the search

```shell
yarn build
```

Development mode with auto-reload on file changes:

```shell
yarn dev
```

## Self-hosted Documentation

Build the project and the static content will be in the `out/` folder.

```shell
yarn build
```

To test locally the exported content run:

```shell
uv run -m http.server --directory out
```

## Building DOCX

To generate a single `.docx` document from all architecture content, run:

```shell
yarn build:docx
```

## References

- [Nextra](https://nextra.site)
- [markdown-toc](https://github.com/thesilk-tux/markdown-toc-gen)
- [arc42-in-markdown-template](https://github.com/NetworkedAssets/arc42-in-markdown-template)
- [Arc42 Skill](https://github.com/melodic-software/claude-code-plugins/tree/main/plugins/documentation-standards/skillshttps://github.com/melodic-software/claude-code-plugins/tree/main/plugins/documentation-standards/skills)
- [World of Webcraft](https://nealford.com/katas/kata?id=WorldOfWebcraft)
