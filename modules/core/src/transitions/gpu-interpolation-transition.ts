import type {Device} from '@luma.gl/api';
import {Timeline} from '@luma.gl/engine';
import {GL, Buffer, Transform} from '@luma.gl/webgl-legacy';
import Attribute from '../lib/attribute/attribute';
import {
  padBuffer,
  getAttributeTypeFromSize,
  getSourceBufferAttribute,
  getAttributeBufferLength,
  cycleBuffers,
  InterpolationTransitionSettings
} from '../lib/attribute/attribute-transition-utils';
import Transition from './transition';

import type {NumericArray} from '../types/types';
import type GPUTransition from './gpu-transition';

export default class GPUInterpolationTransition implements GPUTransition {
  device: Device;
  type = 'interpolation';
  attributeInTransition: Attribute;

  private settings?: InterpolationTransitionSettings;
  private attribute: Attribute;
  private transition: Transition;
  private currentStartIndices: NumericArray | null;
  private currentLength: number;
  private transform: Transform;
  private buffers: Buffer[];

  constructor({
    device,
    attribute,
    timeline
  }: {
    device: Device;
    attribute: Attribute;
    timeline: Timeline;
  }) {
    this.device = device;
    this.transition = new Transition(timeline);
    this.attribute = attribute;
    // this is the attribute we return during the transition - note: if it is a constant
    // attribute, it will be converted and returned as a regular attribute
    // `attribute.userData` is the original options passed when constructing the attribute.
    // This ensures that we set the proper `doublePrecision` flag and shader attributes.
    this.attributeInTransition = new Attribute(device, attribute.settings);
    this.currentStartIndices = attribute.startIndices;
    // storing currentLength because this.buffer may be larger than the actual length we want to use
    // this is because we only reallocate buffers when they grow, not when they shrink,
    // due to performance costs
    this.currentLength = 0;
    this.transform = getTransform(device, attribute);
    const bufferOpts = {
      byteLength: 0,
      usage: GL.DYNAMIC_COPY
    };
    this.buffers = [
      new Buffer(device, bufferOpts), // from
      new Buffer(device, bufferOpts) // current
    ];
  }

  get inProgress(): boolean {
    return this.transition.inProgress;
  }

  // this is called when an attribute's values have changed and
  // we need to start animating towards the new values
  // this also correctly resizes / pads the transform's buffers
  // in case the attribute's buffer has changed in length or in
  // startIndices
  start(transitionSettings: InterpolationTransitionSettings, numInstances: number): void {
    if (transitionSettings.duration <= 0) {
      this.transition.cancel();
      return;
    }
    this.settings = transitionSettings;

    const {device, buffers, attribute} = this;
    // Alternate between two buffers when new transitions start.
    // Last destination buffer is used as an attribute (from state),
    // And the other buffer is now the current buffer.
    cycleBuffers(buffers);

    const padBufferOpts = {
      numInstances,
      attribute,
      fromLength: this.currentLength,
      fromStartIndices: this.currentStartIndices,
      getData: transitionSettings.enter
    };

    for (const buffer of buffers) {
      padBuffer({buffer, ...padBufferOpts});
    }

    this.currentStartIndices = attribute.startIndices;
    this.currentLength = getAttributeBufferLength(attribute, numInstances);
    this.attributeInTransition.setData({
      buffer: buffers[1],
      // Hack: Float64Array is required for double-precision attributes
      // to generate correct shader attributes
      value: attribute.value
    });

    this.transition.start(transitionSettings);

    this.transform.update({
      elementCount: Math.floor(this.currentLength / attribute.size),
      sourceBuffers: {
        aFrom: buffers[0],
        // @ts-expect-error TODO - this looks like a real type mismatch!!!
        aTo: getSourceBufferAttribute(device, attribute)
      },
      feedbackBuffers: {
        vCurrent: buffers[1]
      }
    });
  }

  update(): boolean {
    const updated = this.transition.update();
    if (updated) {
      const {duration, easing} = this.settings;
      const {time} = this.transition;
      let t = time / duration;
      if (easing) {
        t = easing(t);
      }
      this.transform.run({
        uniforms: {time: t}
      });
    }
    return updated;
  }

  cancel(): void {
    this.transition.cancel();
    this.transform.delete();
    for (const buffer of this.buffers) {
      buffer.delete();
    }
    this.buffers.length = 0;
  }
}

const vs = `
#define SHADER_NAME interpolation-transition-vertex-shader

uniform float time;
attribute ATTRIBUTE_TYPE aFrom;
attribute ATTRIBUTE_TYPE aTo;
varying ATTRIBUTE_TYPE vCurrent;

void main(void) {
  vCurrent = mix(aFrom, aTo, time);
  gl_Position = vec4(0.0);
}
`;

function getTransform(device: Device, attribute: Attribute): Transform {
  const attributeType = getAttributeTypeFromSize(attribute.size);
  return new Transform(device, {
    vs,
    defines: {
      ATTRIBUTE_TYPE: attributeType
    },
    varyings: ['vCurrent']
  });
}
