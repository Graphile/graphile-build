// @flow
import type { Plugin, Build } from "../SchemaBuilder";
import type { BuildExtensionQuery } from "./QueryPlugin";

const MutationPayloadQueryPlugin: Plugin = function MutationPayloadQueryPlugin(
  builder
) {
  builder.hook(
    "GraphQLObjectType:fields",
    (
      fields: Object,
      {
        $$isQuery,
        extend,
        getTypeByName,
      }: {| ...Build, ...BuildExtensionQuery |},
      { scope: { isMutationPayload } }
    ): Object => {
      if (!isMutationPayload) {
        return fields;
      }
      const Query = getTypeByName("Query");
      return extend(fields, {
        query: {
          description:
            "Our root query field type. Allows us to run any query from our mutation payload.",
          type: Query,
          resolve() {
            return $$isQuery;
          },
        },
      });
    }
  );
};
export default MutationPayloadQueryPlugin;
