// Prisma's WASM schema parser: no native binary/download required.
const { getDMMF } = require('@prisma/internals');
const { readFileSync } = require('node:fs');
getDMMF({ datamodel: readFileSync('prisma/schema.prisma', 'utf8') })
  .then(dmmf => console.log(`Validated ${dmmf.datamodel.models.length} models with Prisma WASM`))
  .catch(error => { console.error(error); process.exitCode = 1; });
