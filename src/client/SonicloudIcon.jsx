import React from 'react';
import svg from './assets/sonicloud.svg';

export function SonicloudIcon({ size = 16 }) {
  return <span aria-hidden="true" style={{ display: 'inline-flex', width: size, height: size, flexShrink: 0 }}
    dangerouslySetInnerHTML={{ __html: svg }} />;
}
