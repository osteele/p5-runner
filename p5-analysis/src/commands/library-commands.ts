#!/usr/bin/env ts-node
import crypto from 'crypto';
import fs from 'fs';
import fetch from 'node-fetch';
import { Library, Script } from '..';
import nunjucks from 'nunjucks';
import path from 'path';

nunjucks.configure(`${__dirname}/templates`, { autoescape: false });

const roleDescriptions: Record<string, { name?: string; description: string }> =
  Object.fromEntries(
    JSON.parse(
      fs.readFileSync(path.join(__dirname, '../lib/libraries/roles.json'), 'utf-8')
    ).map((role: { key: string }) => [role.key, role])
  );

export function listLibraries() {
  console.log(
    nunjucks.render('list-libraries.njk', {
      libraries: Library.all,
      roleDescriptions,
    })
  );
}

export function generateLibraryPage() {
  const roles = (
    Array.from(new Set(Library.all.map(lib => lib.role))).filter(Boolean) as string[]
  ).map(roleKey => ({
    name: roleDescriptions[roleKey].name || `${capitalize(roleKey)} Libraries`,
    description: roleDescriptions[roleKey].description,
    libraries: Library.all.filter(lib => lib.role === roleKey),
  }));
  const markdown = nunjucks.render('libraries.njk', {
    roles,
    stringify: JSON.stringify,
  });
  console.log(markdown);

  function capitalize(str: string) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

export async function checkLibraryPaths() {
  const missingImportPaths = Library.all.filter(library => !library.importPath);
  if (missingImportPaths.length) {
    console.log(`These libraries are missing import paths:`);
    missingImportPaths.forEach(library =>
      console.log(' ', `${library.name} (${library.homepage})`)
    );
    console.log();
  }

  console.log('Fetching sources...');
  const librariesWithPaths = Library.all.filter(library => library.importPath);
  const responses = await Promise.all(
    librariesWithPaths.map(async library => {
      const res = await cachedFetch(library.importPath!);
      return res.ok
        ? { library, ok: res.ok, text: await res.text() }
        : { library, ok: res.ok };
    })
  );
  console.log('done.\n');

  const invalidImportPaths = responses.filter(res => !res.ok);
  if (invalidImportPaths.length) {
    console.log(`These libraries did not have valid import paths:`);
    invalidImportPaths.forEach(({ library }) =>
      console.log(`  ${library.name} (${library.homepage}) – ${library.importPath}`)
    );
    console.log();
  }
  const libraryScripts = responses
    .filter(res => res.ok)
    .map(({ library, text }): [Library, Script] => [library, Script.fromSource(text!)]);
  const scriptErrors = libraryScripts.filter(
    ([, script]) => script.getErrors().length > 0
  );

  for (const [library, script] of scriptErrors) {
    console.log(`${library.name}:`, library.importPath);
    for (const err of script.getErrors()) {
      console.log(' ', err.message);
    }
  }

  // for (const [library, script] of libraryScripts.filter(([, script]) => !script.getErrors().length)) {
  //   const globals = Array.from(script.globals.keys());
  //   if (globals.length > 0) {
  //     console.log(library.name + ':', globals.join(', '));
  //   } else {
  //     console.log(library.name + ':', 'none');
  //   }
  // }
}

export async function findMinimizedAlternatives() {
  const candidates = Library.all.filter(
    library =>
      library.importPath &&
      library.importPath.endsWith('.js') &&
      !library.importPath.endsWith('.min.js')
  );
  const found = (
    await Promise.all(
      candidates.map(async function (library): Promise<[Library, string] | null> {
        const url = library.importPath!.replace(/\.js$/, '.min.js');
        const res = await cachedFetch(url);
        return res.ok ? [library, url] : null;
      })
    )
  ).filter(Boolean) as [Library, string][];

  if (found.length) {
    console.log('These libraries have minimized alternatives:');
    found.forEach(([library, replacement]) =>
      console.log(`${library.name}\n  ${library.importPath} -> ${replacement}`)
    );
  } else {
    console.log('No libraries have minimized alternatives.');
  }
}

/** Wrapper for node-fetch that looks in a cache directory before fetching from
 * the network. If the cache is missing, it will be created. If the file is
 * missing, it will be fetched from the network and saved to the cache. If the
 * file is present, it will be read from the cache.
 *
 * Usage: const fetch = require('node-fetch-cache'); const res = await
 *  fetch('https://example.com/file.json'); console.log(res.text());
 *
 *  const fetch = require('node-fetch-cache')('/path/to/cache/dir'); const res =
 *  await fetch('https://example.com/file.json'); console.log(res.text());
 */
async function cachedFetch(url: string) {
  const cacheDir = '/tmp/node-fetch-cache';
  // compute the md5 of url
  const hash = crypto.createHash('md5').update(url).digest('hex');
  const cachePath = `${cacheDir}/${hash}`;
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir);
  }
  // if the file is less than a day old, read it from the cache
  if (
    fs.existsSync(cachePath) &&
    fs.statSync(cachePath).mtime.getTime() > Date.now() - 86400000
  ) {
    const text = fs.readFileSync(cachePath, 'utf-8');
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(text),
    };
  } else {
    const res = await fetch(url);
    const text = await res.text();
    if (res.ok) {
      fs.writeFileSync(cachePath, text);
    }
    return {
      ...res,
      ok: res.ok && 200 <= res.status && res.status < 300,
      text: () => Promise.resolve(text),
    };
  }
}
