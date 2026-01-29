#!/usr/bin/env bash

git checkout -b "flowzonify"

COMMIT_MESSAGE="Update flowzone config"

if [[ -f ".resinci.yml" ]]; then
	rm .resinci.yml
fi

if [ ! -f ".github/workflows/flowzone.yml" ]; then
	mkdir -p .github/workflows
	cat << EOF > .github/workflows/flowzone.yml
name: Flowzone

on:
  pull_request:
    types: [opened, synchronize, closed]
    branches: [main, master]
  # allow external contributions to use secrets within trusted code
  pull_request_target:
    types: [opened, synchronize, closed]
    branches: [main, master]

permissions:
  id-token: write  # https://docs.npmjs.com/trusted-publishers
  contents: read
  packages: read  # should we decide to publish to ghcr.io

jobs:
  flowzone:
    name: Flowzone
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
    # prevent duplicate workflow executions for pull_request and pull_request_target
    if: |
      (
        github.event.pull_request.head.repo.full_name == github.repository &&
        github.event_name == 'pull_request'
      ) || (
        github.event.pull_request.head.repo.full_name != github.repository &&
        github.event_name == 'pull_request_target'
      )
    secrets: inherit
EOF

	git add .github/workflows/flowzone.yml

	if [[ -f "karma.conf.js" ]]; then
		npm i -D balena-config-karma@4.0.0 @types/chai@^4.3.0 @types/chai-as-promised@^7.1.5 @types/mocha@^9.1.1 chai@^4.3.4 mocha@^10.0.0 ts-node@^10.0.0 karma@^5.0.0
	fi

	COMMIT_MESSAGE="Replace balenaCI with flowzone"

else
	# if it's an npm module, add the npm OIDC auth permissions section
	if [[ -f "package.json" ]] && ! grep -Pz "(?m)permissions:\s+id-token: write" ".github/workflows/flowzone.yml" > /dev/null; then
		sed -i '/^jobs:/i \
permissions:\
  id-token: write  # https://docs.npmjs.com/trusted-publishers\
  contents: read\
  packages: read  # should we decide to publish to ghcr.io\

' ".github/workflows/flowzone.yml"
	fi
fi

git commit -am "$COMMIT_MESSAGE" -m 'Change-type: patch'
