const { graphql } = require("graphql");
const { withPgClient, getServerVersionNum } = require("../helpers");
const { createPostGraphileSchema } = require("postgraphile-core");
const { readdirSync, readFile: rawReadFile } = require("fs");
const { resolve: resolvePath } = require("path");
const { printSchema } = require("graphql/utilities");
const debug = require("debug")("graphile-build:schema");
const {
  makeExtendSchemaPlugin,
  gql,
  makeJSONPgSmartTagsPlugin,
} = require("graphile-utils");
const ToyCategoriesPlugin = require("./ToyCategoriesPlugin");

function readFile(filename, encoding) {
  return new Promise((resolve, reject) => {
    rawReadFile(filename, encoding, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

const queriesDir = `${__dirname}/../fixtures/queries`;
const queryFileNames = readdirSync(queriesDir);
const testsToSkip = [];
let queryResults = [];

const kitchenSinkData = () =>
  readFile(`${__dirname}/../kitchen-sink-data.analogue.sql`, "utf8");

const dSchemaComments = () =>
  readFile(
    `${__dirname}/../kitchen-sink-d-schema-comments.analogue.sql`,
    "utf8"
  );

const TagsPlugin = makeJSONPgSmartTagsPlugin({
  version: 1,
  config: {
    namespace: {
      a: {
        description: "The a schema.",
      },
      b: {
        description: "qwerty",
      },
    },
    class: {
      "b.updatable_view": {
        tags: {
          uniqueKey: "x",
          description: "YOYOYO!!",
        },
      },
      "smart_comment_relations.houses": {
        tags: {
          primaryKey: "street_id,property_id",
          foreignKey: [
            "(street_id) references smart_comment_relations.streets",
            "(building_id) references smart_comment_relations.buildings (id)",
            "(property_id) references properties",
            "(street_id, property_id) references street_property (str_id, prop_id)",
          ],
        },
      },
      "smart_comment_relations.post_view": {
        tags: {
          name: "posts",
          primaryKey: "id",
        },
      },
      "smart_comment_relations.offer_view": {
        tags: {
          name: "offers",
          primaryKey: "id",
          foreignKey: "(post_id) references post_view (id)",
        },
      },
      "enum_tables.abcd_view": {
        tags: {
          primaryKey: "letter",
          enum: true,
          enumName: "LetterAToDViaView",
        },
      },
    },

    attribute: {
      "b.updatable_view.constant": {
        description: "This is constantly 2",
      },
      "smart_comment_relations.houses.property_name_or_number": {
        tags: { notNull: true },
      },
      "smart_comment_relations.houses.street_name": {
        tags: { notNull: true },
      },
    },
    constraint: {
      "c.person_secret.person_secret_person_id_fkey": {
        tags: {
          forwardDescription: "The `Person` this `PersonSecret` belongs to.",
          backwardDescription: "This `Person`'s `PersonSecret`.",
        },
      },
      "d.post.post_author_id_fkey": {
        tags: { foreignFieldName: "posts", fieldName: "author" },
      },
      "d.person.person_pkey": {
        tags: { fieldName: "findPersonById" },
      },
      "enum_tables.lots_of_enums.enum_1": {
        tags: { enum: true, enumName: "EnumTheFirst" },
      },
      "enum_tables.lots_of_enums.enum_2": {
        tags: { enum: true, enumName: "EnumTheSecond" },
      },
      "enum_tables.lots_of_enums.enum_3": {
        tags: { enum: true },
      },
      "enum_tables.lots_of_enums.enum_4": {
        tags: { enum: true },
      },
    },
  },
});

beforeAll(() => {
  // Get a few GraphQL schema instance that we can query.
  console.log("beforeAll withPgClient");
  const gqlSchemasPromise = withPgClient(async pgClient => {
    console.log("beforeAll getVersion");
    const serverVersionNum = await getServerVersionNum(pgClient);
    if (serverVersionNum < 90500) {
      // Remove tests not supported by PG9.4
      testsToSkip.push("json-overflow.graphql");
    }

    console.log("beforeAll add dSchemaComments");
    // A selection of omit/rename comments on the d schema
    await pgClient.query(await dSchemaComments());
    console.log("beforeAll building schemas");

    // Different fixtures need different schemas with different configurations.
    // Make all of the different schemas with different configurations that we
    // need and wait for them to be created in parallel.
    const [
      normal,
      classicIds,
      dynamicJson,
      pgColumnFilter,
      viewUniqueKey,
      dSchema,
      simpleCollections,
      orderByNullsLast,
      smartCommentRelations,
      largeBigint,
      namedQueryBuilder,
      enumTables,
    ] = await Promise.all([
      createPostGraphileSchema(pgClient, ["a", "b", "c"], {
        subscriptions: true,
        appendPlugins: [
          TagsPlugin,
          makeExtendSchemaPlugin({
            typeDefs: gql`
              extend type Query {
                extended: Boolean
              }
            `,
            resolvers: {
              Query: {
                extended: () => true,
              },
            },
          }),
        ],
      }),
      createPostGraphileSchema(pgClient, ["a", "b", "c"], {
        subscriptions: true,
        classicIds: true,
        appendPlugins: [TagsPlugin],
      }),
      createPostGraphileSchema(pgClient, ["a", "b", "c"], {
        subscriptions: true,
        dynamicJson: true,
        setofFunctionsContainNulls: null,
        appendPlugins: [TagsPlugin],
      }),
      createPostGraphileSchema(pgClient, ["a", "b", "c"], {
        subscriptions: true,
        pgColumnFilter: attr => attr.name !== "headline",
        setofFunctionsContainNulls: false,
        appendPlugins: [TagsPlugin],
      }),
      createPostGraphileSchema(pgClient, ["a", "b", "c"], {
        subscriptions: true,
        viewUniqueKey: "testviewid",
        setofFunctionsContainNulls: true,
        appendPlugins: [TagsPlugin],
      }),
      createPostGraphileSchema(pgClient, ["d"], {
        appendPlugins: [TagsPlugin],
      }),
      createPostGraphileSchema(pgClient, ["a", "b", "c"], {
        subscriptions: true,
        simpleCollections: "both",
        appendPlugins: [TagsPlugin],
      }),
      createPostGraphileSchema(pgClient, ["a"], {
        subscriptions: true,
        graphileBuildOptions: {
          orderByNullsLast: true,
        },
        appendPlugins: [TagsPlugin],
      }),
      createPostGraphileSchema(pgClient, ["smart_comment_relations"], {
        appendPlugins: [TagsPlugin],
      }),
      createPostGraphileSchema(pgClient, ["large_bigint"], {
        appendPlugins: [TagsPlugin],
      }),
      createPostGraphileSchema(pgClient, ["named_query_builder"], {
        subscriptions: true,
        appendPlugins: [ToyCategoriesPlugin, TagsPlugin],
      }),
      createPostGraphileSchema(pgClient, ["enum_tables"], {
        subscriptions: true,
        appendPlugins: [TagsPlugin],
      }),
    ]);
    console.log("beforeAll schemas built");
    debug(printSchema(normal));
    return {
      normal,
      classicIds,
      dynamicJson,
      pgColumnFilter,
      viewUniqueKey,
      dSchema,
      simpleCollections,
      orderByNullsLast,
      smartCommentRelations,
      largeBigint,
      namedQueryBuilder,
      enumTables,
    };
  });

  // Execute all of the queries in parallel. We will not wait for them to
  // resolve or reject. The tests will do that.
  //
  // All of our queries share a single client instance.
  const queryResultsPromise = (async () => {
    // Wait for the schema to resolve. We need the schema to be introspected
    // before we can do anything else!
    const gqlSchemas = await gqlSchemasPromise;
    console.log("withPgClient");
    // Get a new Postgres client instance.
    return await withPgClient(async pgClient => {
      // Add data to the client instance we are using.
      console.log("Loading data");
      await pgClient.query(await kitchenSinkData());
      console.log("Getting version");
      const serverVersionNum = await getServerVersionNum(pgClient);
      // Run all of our queries in parallel.
      const results = [];
      for (const filename of queryFileNames) {
        console.log(`Processing '${filename}'`);
        if (testsToSkip.indexOf(filename) >= 0) {
          results.push(Promise.resolve());
          continue;
        }
        const process = async fileName => {
          console.log("Loading query");
          // Read the query from the file system.
          const query = await readFile(
            resolvePath(queriesDir, fileName),
            "utf8"
          );
          console.log(`Loaded query (${query.length})`);
          // Get the appropriate GraphQL schema for this fixture. We want to test
          // some specific fixtures against a schema configured slightly
          // differently.
          const schemas = {
            "classic-ids.graphql": gqlSchemas.classicIds,
            "dynamic-json.graphql": gqlSchemas.dynamicJson,
            "dynamic-json.condition-json-field-variable.graphql":
              gqlSchemas.dynamicJson,
            "view.graphql": gqlSchemas.viewUniqueKey,
            "badlyBehavedFunction.graphql": gqlSchemas.viewUniqueKey,
            "simple-collections.graphql": gqlSchemas.simpleCollections,
            "simple-relations-head-tail.graphql": gqlSchemas.simpleCollections,
            "simple-relations-tail-head.graphql": gqlSchemas.simpleCollections,
            "simple-procedure-computed-fields.graphql":
              gqlSchemas.simpleCollections,
            "simple-procedure-query.graphql": gqlSchemas.simpleCollections,
            "types.graphql": gqlSchemas.simpleCollections,
            "orderByNullsLast.graphql": gqlSchemas.orderByNullsLast,
          };
          let gqlSchema = schemas[fileName];
          if (!gqlSchema) {
            if (fileName.startsWith("d.")) {
              gqlSchema = gqlSchemas.dSchema;
            } else if (fileName.startsWith("smart_comment_relations.")) {
              gqlSchema = gqlSchemas.smartCommentRelations;
            } else if (fileName.startsWith("large_bigint")) {
              gqlSchema = gqlSchemas.largeBigint;
            } else if (fileName.startsWith("named_query_builder")) {
              gqlSchema = gqlSchemas.namedQueryBuilder;
            } else if (fileName.startsWith("enum_tables.")) {
              gqlSchema = gqlSchemas.enumTables;
            } else {
              gqlSchema = gqlSchemas.normal;
            }
          }
          console.log("Got schema");

          await pgClient.query("savepoint test");

          try {
            console.log("Calling GraphQL");
            // Return the result of our GraphQL query.
            const result = await graphql(gqlSchema, query, null, {
              pgClient: pgClient,
            });
            console.log("GraphQL complete");
            if (result.errors) {
              // eslint-disable-next-line no-console
              console.log(result.errors.map(e => e.originalError || e));
            }
            return result;
          } finally {
            console.log("Finally");
            await pgClient.query("rollback to savepoint test");
          }
        };
        results.push(await process(filename));
      }
      return results;
    });
  })();

  // Flatten out the query results promise.
  queryResults = queryFileNames.map(async (_, i) => {
    return await (await queryResultsPromise)[i];
  });
});

for (let i = 0; i < queryFileNames.length; i++) {
  const filename = queryFileNames[i];
  test(filename, async () => {
    if (testsToSkip.indexOf(filename) >= 0) {
      // eslint-disable-next-line no-console
      console.log(`SKIPPED '${filename}'`);
      // Technically this will never be ran because we handle it in scripts/test
    } else {
      console.log("Awaiting...");
      expect(await queryResults[i]).toMatchSnapshot();
      console.log("Complete");
    }
  });
}
