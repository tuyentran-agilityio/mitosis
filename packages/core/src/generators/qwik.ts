import { NodePath, transform, types } from '@babel/core';
import virtual from '@rollup/plugin-virtual';
import dedent from 'dedent';
import { camelCase, kebabCase, size } from 'lodash';
import { format } from 'prettier/standalone';
import { rollup } from 'rollup';
import traverse from 'traverse';
import { babelTransformExpression } from '../helpers/babel-transform';
import { capitalize } from '../helpers/capitalize';
import { collectCss } from '../helpers/collect-styles';
import { fastClone } from '../helpers/fast-clone';
import { filterEmptyTextNodes } from '../helpers/filter-empty-text-nodes';
import { getStateObjectStringFromComponent } from '../helpers/get-state-object-string';
import { isMitosisNode } from '../helpers/is-mitosis-node';
import { isValidAttributeName } from '../helpers/is-valid-attribute-name';
import { removeSurroundingBlock } from '../helpers/remove-surrounding-block';
import { renderPreComponent } from '../helpers/render-imports';
import { stripMetaProperties } from '../helpers/strip-meta-properties';
import { stripStateAndPropsRefs } from '../helpers/strip-state-and-props-refs';
import {
  Plugin,
  runPostCodePlugins,
  runPostJsonPlugins,
  runPreCodePlugins,
  runPreJsonPlugins,
} from '../modules/plugins';
import { selfClosingTags } from '../parsers/jsx';
import { MitosisComponent } from '../types/mitosis-component';
import { MitosisNode } from '../types/mitosis-node';
import { htmlAttributeEscape } from '../helpers/html-escape';

const qwikImport = (options: InternalToQwikOptions) =>
  options.qwikLib || '@builder.io/qwik';

function addMarkDirtyAfterSetInCode(
  code: string,
  options: InternalToQwikOptions,
  useString = 'markDirty(this)',
) {
  return babelTransformExpression(code, {
    UpdateExpression(path: babel.NodePath<babel.types.UpdateExpression>) {
      const { node } = path;
      if (types.isMemberExpression(node.argument)) {
        if (types.isIdentifier(node.argument.object)) {
          // TODO: utility to properly trace this reference to the beginning
          if (node.argument.object.name === 'state') {
            // TODO: ultimately do updates by property, e.g. updateName()
            // that updates any attributes dependent on name, etc
            let parent: NodePath<any> = path;

            // `_temp = ` assignments are created sometimes when we insertAfter
            // for simple expressions. this causes us to re-process the same expression
            // in an infinite loop
            while ((parent = parent.parentPath)) {
              if (
                types.isAssignmentExpression(parent.node) &&
                types.isIdentifier(parent.node.left) &&
                parent.node.left.name.startsWith('_temp')
              ) {
                return;
              }
            }

            path.insertAfter(types.identifier(useString));
          }
        }
      }
    },
    AssignmentExpression(
      path: babel.NodePath<babel.types.AssignmentExpression>,
    ) {
      const { node } = path;
      if (types.isMemberExpression(node.left)) {
        if (types.isIdentifier(node.left.object)) {
          // TODO: utility to properly trace this reference to the beginning
          if (node.left.object.name === 'state') {
            // TODO: ultimately do updates by property, e.g. updateName()
            // that updates any attributes dependent on name, etc
            let parent: NodePath<any> = path;

            // `_temp = ` assignments are created sometimes when we insertAfter
            // for simple expressions. this causes us to re-process the same expression
            // in an infinite loop
            while ((parent = parent.parentPath)) {
              if (
                types.isAssignmentExpression(parent.node) &&
                types.isIdentifier(parent.node.left) &&
                parent.node.left.name.startsWith('_temp')
              ) {
                return;
              }
            }

            path.insertAfter(types.identifier(useString));
          }
        }
      }
    },
  });
}

const processBinding = (binding: string, options: InternalToQwikOptions) =>
  stripStateAndPropsRefs(addMarkDirtyAfterSetInCode(binding, options), {
    replaceWith: 'this.',
  })
    // Remove trailing semicolon
    .trim()
    .replace(/;$/, '');

const NODE_MAPPERS: {
  [key: string]: (json: MitosisNode, options: InternalToQwikOptions) => string;
} = {
  Fragment(json, options) {
    return `<>${json.children
      .map((item) => blockToQwik(item, options))
      .join('\n')}</>`;
  },
  For(json, options) {
    return `{${processBinding(json.bindings.each as string, options)}.map(${
      json.properties._forName
    } => (
      <>${json.children
        .filter(filterEmptyTextNodes)
        .map((item) => blockToQwik(item, options))
        .join('\n')}</>
    ))}`;
  },
  Show(json, options) {
    return `{${processBinding(json.bindings.when as string, options)} ? (
      <>${json.children
        .filter(filterEmptyTextNodes)
        .map((item) => blockToQwik(item, options))
        .join('\n')}</>
    ) : undefined}`;
  },
};

const getId = (json: MitosisNode, options: InternalToQwikOptions) => {
  const name = json.properties.$name
    ? camelCase(json.properties.$name)
    : /^h\d$/.test(json.name || '') // don't dashcase h1 into h-1
    ? json.name
    : camelCase(json.name || 'div');

  const newNameNum = (options.namesMap[name] || 0) + 1;
  options.namesMap[name] = newNameNum;
  return capitalize(`${name}${newNameNum === 1 ? '' : `${newNameNum}`}`);
};

const elId = (node: MitosisNode, options: InternalToQwikOptions) => {
  if (node.meta.id) {
    return node.meta.id;
  }
  const id = getId(node, options);
  node.meta.id = id;
  return id;
};

type NumberRecord = { [key: string]: number };
type ToQwikOptions = {
  prettier?: boolean;
  plugins?: Plugin[];
  qwikLib?: string;
  qrlPrefix?: string;
  cssNamespace?: string;
  minifyStyles?: boolean;
  qrlSuffix?: string;
  bundle?: boolean;
  format?: 'builder' | 'default';
};
type InternalToQwikOptions = ToQwikOptions & {
  componentJson: MitosisComponent;
  namesMap: NumberRecord;
  qrlPrefix: string;
};

const blockToQwik = (json: MitosisNode, options: InternalToQwikOptions) => {
  if (NODE_MAPPERS[json.name]) {
    return NODE_MAPPERS[json.name](json, options);
  }
  if (json.bindings._text) {
    return `{${processBinding(json.bindings._text, options)}}`;
  }
  if (json.properties._text) {
    return json.properties._text;
  }

  let str = '';

  str += `<${json.name} `;

  if (json.bindings._spread) {
    str += ` {...(${json.bindings._spread})} `;
  }

  for (const key in json.properties) {
    if (!key || key.startsWith('_') || key.startsWith('$')) {
      continue;
    }
    const value = htmlAttributeEscape(json.properties[key] || '');
    if (isValidAttributeName(key)) {
      str += ` ${key}="${value}" `;
    }
  }

  const eventBindings: Record<string, string> = {};
  for (const key in json.bindings) {
    const value = json.bindings[key] as string;
    if (key.startsWith('_') || key.startsWith('$')) {
      continue;
    }

    if (key.startsWith('on')) {
      const useKey = key.replace('on', 'on:').toLowerCase();
      const componentName = getComponentName(options.componentJson, options);
      if (options.bundle) {
        eventBindings[useKey] = `QRL\`${
          options.qrlPrefix
        }/${componentName}/bundle${options.qrlSuffix || ''}.on${elId(
          json,
          options,
        )}${key.slice(2)}\``;
      } else {
        eventBindings[useKey] = `QRL\`${
          options.qrlPrefix
        }/${componentName}_on${elId(json, options)}${key.slice(
          2,
        )}${options.qrlSuffix || ''}\``;
      }
    } else {
      if (!isValidAttributeName(key)) {
        console.warn('Skipping invalid attribute name:', key);
      } else {
        str += ` ${key}={${processBinding(value, options)}} `;
      }
    }
  }

  if (size(eventBindings)) {
    for (const event in eventBindings) {
      str += `${event}={${eventBindings[event]}}`;
    }
  }

  if (selfClosingTags.has(json.name)) {
    return str + ' />';
  }
  str += '>';
  if (json.children) {
    str += json.children.map((item) => blockToQwik(item, options)).join('\n');
  }

  str += `</${json.name}>`;

  return str;
};

const getComponentName = (
  json: MitosisComponent,
  options: InternalToQwikOptions,
) => {
  return capitalize(camelCase(json.name || 'my-component'));
};

// TODO
const getProvidersString = (
  componentJson: MitosisComponent,
  options: InternalToQwikOptions,
): string => {
  return 'null';
};

const formatCode = (
  str: string,
  options: InternalToQwikOptions,
  type: 'typescript' | 'css' = 'typescript',
) => {
  if (options.prettier !== false) {
    try {
      str = format(str, {
        parser: type === 'typescript' ? 'babel-ts' : type,
        plugins: [
          require('prettier/parser-typescript'),
          require('prettier/parser-babel'),
          require('prettier/parser-postcss'),
        ],
      });
    } catch (err) {
      console.warn('Error formatting code', err);
    }
  }
  return str;
};

const getEventHandlerFiles = (
  componentJson: MitosisComponent,
  options: InternalToQwikOptions,
): File[] => {
  const files: File[] = [];

  traverse(componentJson).forEach(function(item) {
    if (isMitosisNode(item)) {
      for (const binding in item.bindings) {
        if (binding.startsWith('on')) {
          const eventHandlerName = elId(item, options) + binding.slice(2);
          const componentName = getComponentName(componentJson, options);
          let str = formatCode(
            `import {
              injectEventHandler,
              provideEvent,
              markDirty
            } from '${qwikImport(options)}';
            import { ${componentName}Component } from './${componentName}_component.js'
            
            export ${
              options.bundle ? `const on${eventHandlerName} =` : 'default'
            } injectEventHandler(
              ${componentName}Component,
              provideEvent(),
              async function (this: ${componentName}Component, event: Event) {
                ${removeSurroundingBlock(
                  processBinding(item.bindings[binding] as string, options),
                )}
              }
            )
          `,
            options,
          );

          str = formatCode(str, options);
          files.push({
            path: `${componentName}_on${eventHandlerName}.ts`,
            contents: str,
          });
        }
      }
    }
  });

  return files;
};

export type File = {
  path: string;
  contents: string;
};

export const componentToQwik = async (
  componentJson: MitosisComponent,
  toQwikOptions: ToQwikOptions = {},
): Promise<{ files: File[] }> => {
  let json = fastClone(componentJson);
  const options = {
    qrlPrefix: 'ui:',
    ...toQwikOptions,
    namesMap: {},
    componentJson: json,
  };
  if (options.plugins) {
    json = runPreJsonPlugins(json, options.plugins);
  }

  let css = collectCss(json, {
    classProperty: 'class',
    prefix: options.cssNamespace,
  });
  if (options.minifyStyles) {
    css = css.trim().replace(/\s+/g, ' ');
  } else {
    css = formatCode(css, options, 'css');
  }
  const hasCss = Boolean(css.trim().length);

  const addWrapper = json.children.length > 1 || hasCss;
  if (options.plugins) {
    json = runPostJsonPlugins(json, options.plugins);
  }
  const componentName = capitalize(
    camelCase(componentJson.name || 'my-component'),
  );
  stripMetaProperties(json);
  let str = dedent`
    import { injectMethod, QRL, jsxFactory } from '${qwikImport(options)}';
    import { ${componentName}Component } from './${componentName}_component.js'
    ${renderPreComponent({
      ...json,
      imports: json.imports.map((item) => {
        if (item.path.endsWith('.lite')) {
          const clone = fastClone(item);
          const name = clone.path
            .split(/[\.\/]/)
            // Get the -1 index of array
            .slice(-2, -1)
            .pop();
          const pascalName = capitalize(camelCase(name));
          clone.path = `../${pascalName}/public.js`;
          for (const key in clone.imports) {
            const value = clone.imports[key];
            if (value === 'default') {
              clone.imports[key] = pascalName;
            }
          }
          return clone;
        }
        return item;
      }),
    })}

    export ${
      options.bundle ? `const template = ` : 'default'
    } injectMethod(${componentName}Component, function (this: ${componentName}Component) {
      return (${addWrapper ? '<>' : ''}
        ${
          !hasCss
            ? ''
            : `<style>{\`${css
                .trim()
                .replace(/^|\n/g, '\n' + ' '.repeat(12))}\`}</style>`
        }
        ${json.children.map((item) => blockToQwik(item, options)).join('\n')}
        ${addWrapper ? '</>' : ''})
    })
  `;

  if (options.plugins) {
    str = runPreCodePlugins(str, options.plugins);
  }
  str = formatCode(str, options);
  if (options.plugins) {
    str = runPostCodePlugins(str, options.plugins);
  }

  const dataString = getStateObjectStringFromComponent(json, {
    format: 'class',
    valueMapper: (code) => processBinding(code, options),
  });

  const output = {
    files: [
      {
        path: `${componentName}_template.tsx`,
        contents: str,
      },
      {
        path: `${componentName}.ts`,
        contents: formatCode(
          `
          import { jsxDeclareComponent, QRL } from '${qwikImport(options)}';
          
          export const ${componentName} = jsxDeclareComponent(QRL\`${
            options.qrlPrefix
          }/${componentName}${
            options.bundle ? '/bundle' : '_template'
          }${options.qrlSuffix || ''}${
            options.bundle ? '.template' : ''
          }\`, '${kebabCase(componentName)}');
        `,
          options,
        ),
      },
      {
        path: `${componentName}_component.ts`,
        contents: formatCode(
          (() => {
            let str = `
              ${options.format === 'builder' ? '' : 'export '}class ${
              options.format === 'builder' ? '_' : ''
            }${componentName}Component extends Component<any, any> {
                ${
                  options.format === 'builder'
                    ? ''
                    : `static $templateQRL = '${
                        options.qrlPrefix
                      }/${componentName}${
                        options.bundle ? '/bundle' : '_template'
                      }${options.qrlSuffix || ''}${
                        options.bundle ? '.template' : ''
                      }'`
                }

                ${dataString}

                ${
                  !json.hooks.onMount
                    ? ''
                    : `
                      constructor(...args) {
                        super(...args);

                        ${processBinding(json.hooks.onMount, options)}
                        }
                      `
                }

                $newState() {
                  return {} // TODO
                }
              }
              ${
                options.format !== 'builder'
                  ? ''
                  : `
              export const ${componentName}Component = new Proxy(_${componentName}Component, {
                get(target, prop) {
                  if (prop === '$templateQRL') {
                    return '${options.qrlPrefix}/${componentName}${
                      options.bundle ? '/bundle' : '_template'
                    }${options.qrlSuffix || ''}${
                      options.bundle ? '.template' : ''
                    }'
                  }
                  return Reflect.get(...arguments)
                }
              })
              `
              }
            `;

            str = `
              import { Component, QRL ${
                str.includes('markDirty(') ? ', markDirty' : ''
              } } from '${qwikImport(options)}';
              ${str}
            `;

            return str;
          })(),
          options,
        ),
      },
      ...getEventHandlerFiles(json, options),
    ],
  };

  if (options.bundle) {
    const moduleMap = {
      entry: output.files
        .filter((file) => !file.path.endsWith('.ts'))
        .map(
          (file) => `export * from './${file.path.replace(/\.tsx?$/, '.js')}';`,
        )
        .join('\n'),
      ...output.files.reduce((memo, arg) => {
        const transformed = transform(arg.contents, {
          sourceFileName: arg.path,
          plugins: [
            [
              require('@babel/plugin-transform-typescript'),
              {
                jsx: 'react',
                isTSX: true,
                allExtensions: true,
                jsxFactory: 'jsxFactory',
                jsxPragma: 'jsxFactory',
              },
            ],
            [
              require('@babel/plugin-transform-react-jsx'),
              {
                pragma: 'jsxFactory',
                pragmaFrag: 'null',
                throwIfNamespace: false,
              },
            ],
            require('@babel/plugin-proposal-class-properties'),
          ],
        });
        memo['./' + arg.path.replace(/\.tsx?$/, '.js')] = transformed!.code!;
        return memo;
      }, {} as Record<string, string>),
    };

    const bundle = await rollup({
      input: 'entry',
      external: [options.qwikLib || '@builder.io/qwik'],
      plugins: [virtual(moduleMap) as any],
    });

    const { output: bundleOutput } = await bundle.generate({
      file: 'bundle.js',
      format: 'esm',
    });

    output.files.push({
      path: `${componentName}/bundle.js`,
      contents: bundleOutput[0].code,
    });
  }

  return output;
};
