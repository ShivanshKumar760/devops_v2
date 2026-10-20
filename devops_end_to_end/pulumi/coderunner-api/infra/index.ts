import { cfg, fqdn } from './config.ts';
import { createAutoscale } from './autoscale.ts';
import { createSingleDroplet } from './single.ts';

const details = cfg.topology === 'autoscale' ? createAutoscale() : createSingleDroplet();

export const url = `https://${fqdn}`;
export const resources = details;