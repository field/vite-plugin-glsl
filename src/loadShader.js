import { dirname, resolve, extname, posix, sep } from 'path';
import { emitWarning, cwd } from 'process';
import { readFileSync, existsSync } from 'fs';
import { platform } from 'os';

/**
 * @name recursiveChunk
 * @type {string}
 * 
 * @description Shader chunk path
 * that caused a recursion error
 */
let recursiveChunk = '';

/**
 * @const
 * @name allChunks
 * @type {readonly Set<string>}
 * 
 * @description List of all shader chunks,
 * it's used to track included files
 */
const allChunks = new Set();

/**
 * @const
 * @name dependentChunks
 * @type {readonly Map<string, string[]>}
 * 
 * @description Map of shaders that import other chunks, it's
 * used to track included files in order to avoid recursion
 * - Key: shader path that uses other chunks as dependencies
 * - Value: list of chunk paths included within the shader
 */
const dependentChunks = new Map();

/**
 * @const
 * @name duplicatedChunks
 * @type {readonly Map<string, string[]>}
 * 
 * @description Map of duplicated shader
 * imports, used by warning messages
 */
const duplicatedChunks = new Map();

/**
 * @function
 * @name resetSavedChunks
 * @description Clears all lists of saved chunks
 * and resets "recursiveChunk" path to empty
 * 
 * @returns {string} Copy of "recursiveChunk" path
 */
function resetSavedChunks () {
  const chunk = recursiveChunk;
  duplicatedChunks.clear();
  dependentChunks.clear();

  recursiveChunk = '';
  allChunks.clear();
  return chunk;
}

/**
 * @function
 * @name isBareSpecifier
 * @description Checks if a chunk path is a bare (package) specifier,
 * i.e. it's neither a relative ("./", "../") nor a root ("/") import
 * 
 * @param {string} path Chunk path as written in the import statement
 * 
 * @returns {boolean} Whether the chunk path is a bare specifier
 */
function isBareSpecifier (path) {
  return !/^(?:\.{1,2}\/|\/|[a-z]:[\\/])/i.test(path);
}

/**
 * @const
 * @name exportConditions
 * @type {readonly string[]}
 * 
 * @description Conditions accepted when resolving a package.json
 * "exports" target object, the first matching key in the target wins
 */
const exportConditions = ['glsl', 'import', 'default'];

/**
 * @function
 * @name parsePackageSpecifier
 * @description Splits a bare specifier into the package name
 * (including its scope) and the "./"-prefixed subpath within it
 * 
 * @param {string} specifier Bare package specifier of the chunk
 * 
 * @returns {{ name: string, subpath: string }} Package name and subpath
 */
function parsePackageSpecifier (specifier) {
  const segments = specifier.split('/');
  const length = specifier.startsWith('@') ? 2 : 1;

  const name = segments.slice(0, length).join('/');
  const rest = segments.slice(length).join('/');

  return { name, subpath: rest ? `./${rest}` : '.' };
}

/**
 * @function
 * @name resolveExportTarget
 * @description Resolves an "exports" target value to a single relative
 * path. Strings are returned as is, arrays yield their first resolvable
 * entry and condition objects are matched against "exportConditions"
 * 
 * @param {string | string[] | Record<string, unknown> | null} target Exports target
 * 
 * @returns {string | undefined} Relative target path if resolvable
 */
function resolveExportTarget (target) {
  if (typeof target === 'string') return target;
  if (!target) return;

  if (Array.isArray(target)) {
    for (const entry of target) {
      const resolved = resolveExportTarget(entry);
      if (resolved) return resolved;
    }

    return;
  }

  for (const condition of Object.keys(target)) {
    if (exportConditions.includes(condition)) {
      const resolved = resolveExportTarget(target[condition]);
      if (resolved) return resolved;
    }
  }
}

/**
 * @function
 * @name resolvePackageExports
 * @description Maps a package subpath through the package.json "exports"
 * field of a package. Supports exact keys ("./noise/2d.glsl"), subpath
 * patterns ("./noise/*") and directory prefixes ("./noise" -> "./src/noise",
 * the remainder of the subpath is appended to the target)
 * 
 * @param {string} packageDirectory Absolute path of the package directory
 * @param {string} subpath          "./"-prefixed subpath within the package
 * 
 * @returns {string | undefined} Absolute path of the chunk if mapped
 */
function resolvePackageExports (packageDirectory, subpath) {
  const manifest = resolve(packageDirectory, 'package.json');
  if (!existsSync(manifest)) return;

  let exports;

  try {
    exports = JSON.parse(readFileSync(manifest, 'utf8')).exports;
  }
  catch {
    return;
  }

  if (exports === undefined || exports === null) return;

  const isMap = typeof exports === 'object' && !Array.isArray(exports) &&
    Object.keys(exports).every(key => key.startsWith('.'));

  if (!isMap) exports = { '.': exports };

  let match;

  for (const key of Object.keys(exports)) {
    let target, remainder = '';

    if (key === subpath) target = key;

    else if (key.includes('*')) {
      const [prefix, suffix] = key.split('*');

      if (
        subpath.startsWith(prefix) &&
        subpath.endsWith(suffix) &&
        subpath.length >= prefix.length + suffix.length
      ) {
        target = key;
        remainder = subpath.slice(prefix.length, subpath.length - suffix.length);
      }
    }

    else {
      const prefix = key.endsWith('/') ? key : `${key}/`;

      if (subpath.startsWith(prefix)) {
        target = key;
        remainder = subpath.slice(prefix.length);
      }
    }

    if (target && (!match || target.length > match.key.length)) {
      match = { key: target, remainder };
    }
  }

  if (!match) return;

  const target = resolveExportTarget(exports[match.key]);
  if (!target) return;

  const mapped = match.key.includes('*')
    ? target.replace(/\*/g, match.remainder)
    : match.key === subpath ? target
    : posix.join(target, match.remainder);

  const path = resolve(packageDirectory, mapped);
  if (existsSync(path)) return path;
}

/**
 * @function
 * @name resolveNodeModule
 * @description Resolves a bare specifier (e.g. "glsl-noise/simplex/2d.glsl"
 * or "@scope/pkg/chunk.glsl") to an absolute path by walking up all
 * "node_modules" directories starting from the importing shader's directory
 * and falling back to the "node_modules" directory of the current working one.
 * Within a package, the package.json "exports" map is honored first and
 * the raw file path inside the package is used as a fallback
 * 
 * @param {string} specifier Bare package specifier of the chunk
 * @param {string} directory Directory of the shader importing the chunk
 * @param {string} ext       Extension to append if the specifier has none
 * 
 * @returns {string | undefined} Absolute path of the chunk if found
 */
function resolveNodeModule (specifier, directory, ext) {
  const chunk = extname(specifier) ? specifier : `${specifier}.${ext}`;
  const { name, subpath } = parsePackageSpecifier(chunk);
  const directories = [];

  for (let current = resolve(directory); ; current = dirname(current)) {
    directories.push(current);
    if (dirname(current) === current) break;
  }

  directories.push(cwd());

  for (const current of directories) {
    const packageDirectory = resolve(current, 'node_modules', name);
    if (!existsSync(packageDirectory)) continue;

    const exported = resolvePackageExports(packageDirectory, subpath);
    if (exported) return exported;

    const path = resolve(current, 'node_modules', chunk);
    if (existsSync(path)) return path;
  }
}

/**
 * @function
 * @name getRecursionCaller
 * @description Gets last chunk that caused a
 * recursion error from the "dependentChunks" list
 * 
 * @returns {string} Chunk path that started a recursion
 */
function getRecursionCaller () {
  const dependencies = [...dependentChunks.keys()];
  return dependencies[dependencies.length - 1];
}

/**
 * @function
 * @name checkDuplicatedImports
 * @description Checks if shader chunk was already included
 * and adds it to the "duplicatedChunks" list if yes
 * 
 * @param {string} path Shader's absolute path
 * 
 * @throws {Warning} If shader chunk was already included
 */
function checkDuplicatedImports (path) {
  const caller = getRecursionCaller();

  const chunks = duplicatedChunks.get(caller) ?? [];
  if (chunks.includes(path)) return;

  chunks.push(path);
  duplicatedChunks.set(caller, chunks);

  emitWarning(`'${path}' was included multiple times.`, {
    code: 'vite-plugin-glsl',
    detail: 'Please avoid multiple imports of the same chunk in order to avoid' +
    ` recursions and optimize your shader length.\nDuplicated import found in file '${caller}'.`
  });
}

/**
 * @function
 * @name removeSourceComments
 * @description Removes comments from shader source
 * code in order to avoid including commented chunks
 * Triple-slash comments are meant to be preserved,
 * but to avoid errors, they will be removed anyway
 * when containing import keywords or block comments
 * 
 * @param {string}  source  Shader's source code
 * @param {RegExp}  pattern RegExp to import chunks
 * @param {boolean} triple  Remove triple slash comments
 * 
 * @returns {string} Shader's source code without comments
 */
function removeSourceComments (source, pattern, triple = false) {
  const lines = source.split('\n');
  const comments = /\/\*|\*\//;

  for (let l = lines.length; l--; ) {
    const index = lines[l].indexOf('//');

    if (index > -1) {
      if (
        lines[l][index + 2] === '/' &&
        !comments.test(lines[l]) &&
        !pattern.test(lines[l]) &&
        !triple
      )
        continue;

      lines[l] = lines[l].slice(0, index);
    }
  }

  source = lines.join('\n');

  while (true) {
    const startBlock = source.indexOf('/*');
    const endBlock = source.indexOf('*/', startBlock);

    if (startBlock < 0 && endBlock < 0) break;

    else if (startBlock > -1 && endBlock > -1)
      source = source.slice(0, startBlock) +
        source.slice(endBlock + 2);

    else {
      const chunk = source.slice(
        startBlock * +(endBlock === -1),
        (startBlock === -1 && endBlock + 2) || void 0
      );

      const comment = startBlock === -1 && '/*' || '*/';
      const missing = startBlock === -1 && 'open' || 'clos';

      emitWarning(`Block comment was not ${missing}ed.`, {
        code: 'vite-plugin-glsl',
        detail: `Cannot find the corresponding ${missing}ing comment (${comment}) to the one in the` +
        ` chunk below.\nMake sure it's present and not commented out by a line comment:\n\n${chunk}`
      });

      break;
    }
  }

  return source;
}

/**
 * @function
 * @name checkRecursiveImports
 * @description Checks if shader dependencies
 * have caused a recursion error or warning
 * ignoring duplicate chunks if required
 * 
 * @param {string}  path    Shader's absolute path
 * @param {string}  lowPath Shader's lowercase path
 * @param {boolean} warn    Check already included chunks
 * @param {boolean} ignore  Ignore already included chunks
 * 
 * @returns {boolean | null} Import recursion has occurred
 * or chunk was ignored because of `ignore` argument
 */
function checkRecursiveImports (path, lowPath, warn, ignore) {
  if (allChunks.has(lowPath)) {
    if (ignore) return null;
    warn && checkDuplicatedImports(path);
  }

  return checkIncludedDependencies(path, path);
}

/**
 * @function
 * @name checkIncludedDependencies
 * @description Checks if included
 * chunks caused a recursion error
 * 
 * @param {string} path Current chunk absolute path
 * @param {string} root Main shader path that imports chunks
 * 
 * @returns {boolean} Included chunk started a recursion
 */
function checkIncludedDependencies (path, root) {
  const dependencies = dependentChunks.get(path);
  let recursiveDependency = false;

  if (dependencies?.includes(root)) {
    recursiveChunk = root;
    return true;
  }

  dependencies?.forEach(dependency => recursiveDependency ||=
    checkIncludedDependencies(dependency, root)
  );

  return recursiveDependency;
}

/**
 * @function
 * @name minifyShader
 * @description Minifies shader source code by
 * removing unnecessary whitespace and empty lines
 * 
 * @param {string}  shader  Shader code with included chunks
 * @param {boolean} newLine Flag to require a new line for the code
 * 
 * @returns {string} Minified shader's source code
 */
export function minifyShader (shader, newLine = false) {
  const getAllCharIndexes = (line, char = '-', start = 0) => {
    const indexes = [];

    while ((start = line.indexOf(char, start)) !== -1)
      indexes.push(start++);

    return indexes;
  };

  return shader.replace(/\\(?:\r\n|\n\r|\n|\r)|\/\*.*?\*\/|\/\/(?:\\(?:\r\n|\n\r|\n|\r)|[^\n\r])*/g, '')
    .split(/\n+/).reduce((result, line) => {
      line = line.trim().replace(/\s{2,}|\t/g, ' ');

      if (/@(vertex|fragment|compute)/.test(line) || line.endsWith('return')) line += ' ';

      if (line[0] === '#') {
        newLine && result.push('\n');
        result.push(line, '\n');
        newLine = false;
      }

      else {
        !line.startsWith('{') && result.length && result[result.length - 1].endsWith('else') && result.push(' ');
        line = line.replace(/\s*({|}|=|\*|,|\+|\/|>|<|&|\||\[|\]|\(|\)|!|;)\s*/g, '$1');
        const indexes = getAllCharIndexes(line);

        indexes.forEach(index => {
          if (line[index - 1] === ' ' && line[index - 2] !== '-') line = `${line.slice(0, index - 1)}${line.slice(index--)}`;
          if (line[index + 1] === ' ' && line[index + 2] !== '-') line = `${line.slice(0, index + 1)}${line.slice(index + 2)}`;
        });

        result.push(line);
        newLine = true;
      }

      return result;
    }, []).join('').replace(/\n+/g, '\n');
}

/**
 * @function
 * @name loadChunks
 * @description Includes shader's dependencies
 * and removes comments from the source code
 * 
 * @param {string}  source  Shader's source code
 * @param {string}  path    Shader's absolute path
 * @param {RegExp}  pattern RegExp to import chunks
 * @param {Options} options Shader loading config object
 * 
 * @throws {Error} If shader chunks started a recursion loop
 * 
 * @returns {string} Shader's source code without external chunks
 */
function loadChunks (source, path, pattern, options) {
  const unixPath = path.split(sep).join(posix.sep);

  const chunkPath = platform() === 'win32' &&
    unixPath.toLowerCase() || unixPath;

  const recursion = checkRecursiveImports(
    unixPath, chunkPath,
    options.warnDuplicatedImports,
    options.removeDuplicatedImports
  );

  if (recursion) return recursiveChunk;
  else if (recursion === null) return '';

  source = removeSourceComments(source, pattern);
  let directory = dirname(unixPath);
  allChunks.add(chunkPath);

  if (pattern.test(source)) {
    dependentChunks.set(unixPath, []);
    const currentDirectory = directory;
    const ext = options.defaultExtension;

    source = source.replace(pattern, (_, ...[, chunkPath]) => {
      chunkPath = chunkPath.trim().replace(/^(?:"|')?|(?:"|')?;?$/gi, '');
      const specifier = chunkPath;

      if (!chunkPath.indexOf('/')) {
        const base = cwd().split(sep).join(posix.sep);
        chunkPath = base + options.root + chunkPath;
      }

      const directoryIndex = chunkPath.lastIndexOf('/');
      directory = currentDirectory;

      if (directoryIndex !== -1) {
        directory = resolve(directory, chunkPath.slice(0, directoryIndex + 1));
        chunkPath = chunkPath.slice(directoryIndex + 1, chunkPath.length);
      }

      let shader = resolve(directory, chunkPath);
      if (!extname(shader)) shader = `${shader}.${ext}`;

      if (!existsSync(shader) && isBareSpecifier(specifier)) {
        const module = resolveNodeModule(specifier, currentDirectory, ext);

        if (!module) throw new Error(
          `Unable to resolve "${specifier}" imported in "${unixPath}": ` +
          'no such file relative to the shader nor in any "node_modules" directory ' +
          '(neither through the package.json "exports" map nor as a raw package path).'
        );

        shader = module;
      }

      const shaderPath = shader.split(sep).join(posix.sep);
      dependentChunks.get(unixPath)?.push(shaderPath);

      return loadChunks(
        readFileSync(shader, 'utf8'),
        shader, pattern, options
      );
    });
  }

  if (recursiveChunk) {
    const caller = getRecursionCaller();
    const recursiveChunk = resetSavedChunks();

    throw new Error(
      `Recursion detected when importing "${recursiveChunk}" in "${caller}".`
    );
  }

  return source.trim().replace(/(\r\n|\r|\n){3,}/g, '$1\n');
}

/**
 * @function
 * @name loadShader
 * @description Iterates through all external chunks, includes them
 * into the shader's source code and optionally minifies the output
 * 
 * @typedef {import('./types').LoadingOptions} Options
 * @typedef {import('./types').LoadingOutput} Output
 * 
 * @param {string}  source  Shader's source code
 * @param {string}  shader  Shader's absolute path
 * @param {Options} options Configuration object to define:
 * 
 *  - Shader suffix to use when no extension is specified
 *  - Warn if the same chunk was imported multiple times
 *  - Automatically remove an already imported chunk
 *  - Optional function to call with output shader
 *  - Keywords used to import shader chunks
 *  - Directory for root imports
 *  - Minify output shader code
 * 
 * @returns {Promise<Output>} Loaded, parsed (and minified)
 * shader output and Map of shaders that import other chunks
 */
export default async function (source, shader, options) {
  const pattern = new RegExp(String.raw`(${
    options.importKeywords.join('|')
  })(\s+([^\s<>]+));?`, 'gi');

  resetSavedChunks();

  let outputShader = loadChunks(source, shader, pattern, options);

  options.minify && (outputShader = minifyShader(
    removeSourceComments(outputShader, pattern, true))
  );

  outputShader = await options.onComplete?.(outputShader, shader) ?? outputShader;

  return { dependentChunks, outputShader };
}
