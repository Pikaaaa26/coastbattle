import { useEffect, useState } from 'react';
import type { BuildingType } from '@shared/types';
import { buildingIconUrl } from '../game/three/icons';

export function BuildingIcon({
  type,
  size = 40,
  color = '#3fb6ff',
}: {
  type: BuildingType;
  size?: number;
  color?: string;
}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    setUrl(buildingIconUrl(type, color));
  }, [type, color]);
  if (!url) return <span style={{ width: size, height: size, display: 'inline-block' }} />;
  return <img src={url} width={size} height={size} style={{ display: 'block' }} alt={type} draggable={false} />;
}
