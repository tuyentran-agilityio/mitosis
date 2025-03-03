import json5 from 'json5';
import { camelCase, size } from 'lodash';
import { fastClone } from '../helpers/fast-clone';
import traverse from 'traverse';
import { ClassStyleMap } from '../helpers/collect-styles';
import { isMitosisNode } from '../helpers/is-mitosis-node';
import { Plugin } from '../modules/plugins';
import { MitosisComponent } from '../types/mitosis-component';
import { componentToReact } from './react';

type ToReactNativeOptions = {
  prettier?: boolean;
  stylesType?: 'emotion' | 'react-native';
  stateType?: 'useState' | 'mobx' | 'valtio' | 'solid' | 'builder';
  plugins?: Plugin[];
};

export const collectReactNativeStyles = (
  json: MitosisComponent,
): ClassStyleMap => {
  const styleMap: ClassStyleMap = {};

  const componentIndexes: { [className: string]: number | undefined } = {};

  traverse(json).forEach(function(item) {
    if (isMitosisNode(item)) {
      if (typeof item.bindings.css === 'string') {
        const value = json5.parse(item.bindings.css);
        delete item.bindings.css;
        if (!size(value)) {
          return;
        }
        const componentName = camelCase(item.name || 'view');
        const index = (componentIndexes[componentName] =
          (componentIndexes[componentName] || 0) + 1);
        const className = `${componentName}${index}`;
        item.bindings.style = `styles.${className}`;

        styleMap[className] = value;
      }
    }
  });

  return styleMap;
};

export const componentToReactNative = (
  componentJson: MitosisComponent,
  options: ToReactNativeOptions,
) => {
  const json = fastClone(componentJson);
  traverse(json).forEach((node) => {
    if (isMitosisNode(node)) {
      // TODO: handle TextInput, Image, etc
      if (node.name.toLowerCase() === node.name) {
        node.name = 'View';
      }

      if (
        node.properties._text?.trim().length ||
        node.bindings._text?.trim()?.length
      ) {
        node.name = 'Text';
      }
    }
  });

  return componentToReact(json, {
    ...options,
    stylesType: options.stylesType || 'react-native',
    type: 'native',
  });
};
