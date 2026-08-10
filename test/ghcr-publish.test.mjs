import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';

function parseWorkflow(source) {
  const document = parseDocument(source);
  assert.equal(
    document.errors.length,
    0,
    `Workflow YAML must parse: ${document.errors.map((error) => error.message).join('; ')}`,
  );
  return document.toJS();
}

test('development image publishing is trusted-main-only, pinned, and least privileged', async () => {
  const root = resolve(process.cwd());
  const source = await readFile(resolve(root, '.github/workflows/publish-dev-image.yml'), 'utf8');
  const workflow = parseWorkflow(source);
  const publish = workflow.jobs?.publish;
  const steps = publish?.steps;

  assert.deepEqual(workflow.on, { push: { branches: ['main'] } });
  assert.equal(Object.hasOwn(workflow.on, 'pull_request'), false);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.concurrency, {
    group: 'ghcr-development-${{ github.repository }}-${{ github.ref }}',
    'cancel-in-progress': true,
  });
  assert.match(publish.if, /github\.repository == 'mkronvold-wtg\/content-viewer'/);
  assert.match(publish.if, /github\.event\.repository\.fork == false/);
  assert.match(publish.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(publish.if, /github\.ref_protected == true/);
  assert.deepEqual(publish.permissions, {
    contents: 'read',
    packages: 'write',
  });

  const actions = steps.filter((step) => step.uses);
  assert.equal(actions.length, 4);
  assert.equal(actions.every((step) => /^[^@\s]+@[a-f0-9]{40}$/.test(step.uses)), true);
  assert.equal(
    steps.find((step) => step.name === 'Check out source').with?.['persist-credentials'],
    false,
  );

  const login = steps.find((step) => step.name === 'Log in to GitHub Container Registry');
  assert.equal(login.with?.registry, 'ghcr.io');
  assert.equal(login.with?.password, '${{ github.token }}');

  const build = steps.find((step) => step.name === 'Build and publish development image');
  assert.equal(build.with?.platforms, 'linux/amd64');
  assert.equal(build.with?.push, true);
  assert.deepEqual(build.with?.tags.trim().split('\n'), [
    'ghcr.io/mkronvold-wtg/content-viewer:dev',
    'ghcr.io/mkronvold-wtg/content-viewer:sha-${{ github.sha }}',
  ]);
  assert.match(build.with?.labels, /org\.opencontainers\.image\.source=https:\/\/github\.com\/\$\{\{ github\.repository \}\}/);
  assert.match(build.with?.labels, /org\.opencontainers\.image\.revision=\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(build.with?.tags, /latest/);
});
