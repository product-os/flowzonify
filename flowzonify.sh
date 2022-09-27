#!/bin/bash

git checkout -b "flowzonify";

if [[ -f "repo.yml" ]]; then
	rm repo.yml
	git add repo.yml
fi

if [[ -f ".resinci.yml" ]]; then
	rm .resinci.yml
fi

if [ ! -f ".github/workflows/flowzone.yml" ]; then
	if [ ! -d ".github/workflows" ]; then
		mkdir -p .github/workflows
	fi
	printf 'name: Flowzone

on:
  pull_request:
    types: [opened, synchronize, closed]
    branches:
      - "main"
      - "master"

jobs:
  flowzone:
    name: Flowzone
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
    secrets:
      FLOWZONE_TOKEN: ${{ secrets.FLOWZONE_TOKEN }}
      GPG_PRIVATE_KEY: ${{ secrets.GPG_PRIVATE_KEY }}
      GPG_PASSPHRASE: ${{ secrets.GPG_PASSPHRASE }}
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
' > .github/workflows/flowzone.yml
	git add .github/workflows/flowzone.yml
fi

if [[ -f "karma.conf.js" ]]; then
	npm i -D balena-config-karma@4.0.0 @types/chai@^4.3.0 @types/chai-as-promised@^7.1.5 @types/mocha@^9.1.1 chai@^4.3.4 mocha@^10.0.0 ts-node@^10.0.0 karma@^5.0.0
fi

git commit -am 'Replace balenaCI with flowzone

Change-type: patch';
