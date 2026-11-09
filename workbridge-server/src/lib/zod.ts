import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

/**
 * The one `z` every schema imports — request schemas in `src/schemas/` and the response schemas in
 * `src/openapi/responses/`. Importing it adds `.openapi()` (documentation metadata) to every zod
 * type, so the OpenAPI document (`src/openapi/`) is generated from the same schemas `validate()`
 * runs. The metadata never changes how a schema parses.
 *
 * The extension patches zod's prototypes and must run before any schema is built, which is why it
 * lives here, in the module the schemas import `z` from, rather than in `src/openapi/`.
 */
extendZodWithOpenApi(z);

export { z };
