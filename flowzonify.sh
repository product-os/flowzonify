#!/bin/bash

git checkout -b "flowzonify";

if [[ ! -f "repo.yml" ]]; then
	printf "type: 'node'\n" > repo.yml
	git add repo.yml
fi

printf "disabled: true\n" > .resinci.yml
git add .resinci.yml

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
	cp ~/Resin.io/balena-io-modules/balena-request/karma.conf.js karma.conf.js
fi

git commit -am 'Replace balenaCI with flowzone

Change-type: patch';
