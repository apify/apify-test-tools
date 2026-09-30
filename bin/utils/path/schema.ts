import z from 'zod';

import { ExistingDir, ExistingFile, RelativeDir, RelativeFile } from './repo-relative.js';

const parsePath = <T>(construct: (value: string) => T) =>
    z.string().transform((value, ctx): T | typeof z.NEVER => {
        try {
            return construct(value);
        } catch (error) {
            ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) });
            return z.NEVER;
        }
    });

export const RelativeDirSchema = parsePath((value) => new RelativeDir(value));
export const ExistingDirSchema = parsePath((value) => new ExistingDir(value));
export const RelativeFileSchema = parsePath((value) => new RelativeFile(value));
export const ExistingFileSchema = parsePath((value) => new ExistingFile(value));
