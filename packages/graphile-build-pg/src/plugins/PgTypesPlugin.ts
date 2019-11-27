import {
  Plugin,
  GraphileObjectTypeConfig,
  ScopeGraphQLObjectType,
  GraphileInputObjectTypeConfig,
  Build,
  Inflection,
} from "graphile-build";

import makeGraphQLJSONType from "../GraphQLJSON";

import rawParseInterval = require("postgres-interval");
import LRU from "@graphile/lru";
import {
  GraphQLType,
  GraphQLInputType,
  GraphQLObjectType,
  GraphQLNamedType,
  GraphQLOutputType,
} from "graphql";
import { PgType, PgEntity } from "./PgIntrospectionPlugin";
import { InflectionBase } from "graphile-build/node8plus/makeNewBuild";

interface GqlTypeByTypeIdAndModifier {
  [typeId: string]: {
    [modifier: string]: GraphQLOutputType;
  };
}
interface GqlInputTypeByTypeIdAndModifier {
  [typeId: string]: {
    [modifier: string]: GraphQLInputType;
  };
}

type TypeGen<T> = (
  set: (type: T) => void,
  typeModifier: string | null
) => void | T;

type Pg2GqlMapper = {
  [id: string]: {
    map: any;
    unmap: any;
  };
};

declare module "graphile-build" {
  interface Build {
    pgGqlTypeByTypeIdAndModifier?: GqlTypeByTypeIdAndModifier;
    pgGqlInputTypeByTypeIdAndModifier?: GqlInputTypeByTypeIdAndModifier;

    pgRegisterGqlTypeByTypeId(
      typeId: string,
      gen: TypeGen<GraphQLOutputType>,
      yieldToExisting?: boolean
    ): void;
    pgRegisterGqlInputTypeByTypeId(
      typeId: string,
      gen: TypeGen<GraphQLInputType>,
      yieldToExisting?: boolean
    ): void;
    pgGetGqlTypeByTypeIdAndModifier(
      typeId: string,
      typeModifier: string | null,
      useFallback?: boolean
    ): GraphQLOutputType | null;
    pgGetGqlInputTypeByTypeIdAndModifier(
      typeId: string,
      typeModifier: string | null,
      useFallback?: boolean
    ): GraphQLInputType | null;
    pg2GqlMapper: Pg2GqlMapper;
    pg2gql;
    pg2gqlForType;
    gql2pg;
    pgTweakFragmentForTypeAndModifier;
    pgTweaksByTypeId;
    pgTweaksByTypeIdAndModifer;
  }

  interface GraphileBuildOptions {
    pgExtendedTypes?: boolean;
    pgSkipHstore?: boolean;
    pgUseCustomNetworkScalars?: boolean;
    disableIssue390Fix?: boolean;
  }

  interface ScopeGraphQLObjectType {
    pgIntrospection?: PgEntity;
    pgSubtypeIntrospection?: PgEntity;
    pgTypeModifier?: string | number;
    isIntervalType?: true;
    isPointType?: true;
    isPgRangeType?: true;
    isPgRangeBoundType?: true;
  }

  interface ScopeGraphQLInputObjectType {
    pgIntrospection?: PgEntity;
    pgSubtypeIntrospection?: PgEntity;
    pgTypeModifier?: string | number;
    isIntervalInputType?: true;
    isPointInputType?: true;
    isPgRangeInputType?: true;
    isPgRangeBoundInputType?: true;
  }

  interface ScopeGraphQLEnumType {
    pgIntrospection?: PgType;
    isPgEnumType?: true;
  }

  interface Inflection {
    hstoreType(): string;
  }
}

function indent(str) {
  return "  " + str.replace(/\n/g, "\n  ");
}

function identity(value) {
  return value;
}

const parseCache = new LRU({ maxLength: 500 });
function parseInterval(str) {
  let result = parseCache.get(str);
  if (!result) {
    result = rawParseInterval(str);
    Object.freeze(result);
    parseCache.set(str, result);
  }
  return result;
}

export default (function PgTypesPlugin(
  builder,
  {
    pgExtendedTypes = true,
    // Adding hstore support is technically a breaking change; this allows people to opt out easily:
    pgSkipHstore = false,
    pgUseCustomNetworkScalars = false,
    disableIssue390Fix = false,
  }
) {
  // XXX: most of this should be in an "init" hook, not a "build" hook
  builder.hook(
    "build",
    build => {
      const {
        pgIntrospectionResultsByKind: rawIntrospectionResultsByKind,
        getTypeByName,
        pgSql: sql,
        inflection,
        graphql,
      } = build;
      if (!rawIntrospectionResultsByKind || !sql) {
        throw new Error("Required helpers were not found on Build.");
      }
      const introspectionResultsByKind = rawIntrospectionResultsByKind;

      /*
       * Note these do not do `foo.bind(build)` because they want to reference
       * the *latest* value of foo (i.e. after all the build hooks run, some of
       * which might overwrite it on the build object) rather than the current
       * value of foo in this current hook.
       *
       * Also don't use this in your own code, only construct types *after* the
       * build hook has completed (i.e. 'init' or later).
       *
       * TODO:v5: move this to the 'init' hook.
       */
      const newWithHooks: typeof build.newWithHooks = (...args: any[]) =>
        (build.newWithHooks as any)(...args);
      const addType: typeof build.addType = (...args: any[]) =>
        (build.addType as any)(...args);

      const {
        GraphQLNonNull,
        GraphQLString,
        GraphQLInt,
        GraphQLFloat,
        GraphQLBoolean,
        GraphQLList,
        GraphQLEnumType,
        GraphQLObjectType,
        GraphQLInputObjectType,
        GraphQLScalarType,
        isInputType,
        getNamedType,
        Kind,
      } = graphql;

      const gqlTypeByTypeIdGenerator = {};
      const gqlInputTypeByTypeIdGenerator = {};
      if (build["pgGqlTypeByTypeId"] || build["pgGqlInputTypeByTypeId"]) {
        // I don't expect anyone to receive this error, because I don't think anyone uses this interface.
        throw new Error(
          "Sorry! This interface is no longer supported because it is not granular enough. It's not hard to port it to the new system - please contact Benjie and he'll walk you through it."
        );
      }
      const gqlTypeByTypeIdAndModifier: GqlTypeByTypeIdAndModifier = {
        ...build.pgGqlTypeByTypeIdAndModifier,
      };

      const gqlInputTypeByTypeIdAndModifier: GqlInputTypeByTypeIdAndModifier = {
        ...build.pgGqlInputTypeByTypeIdAndModifier,
      };

      const isNull = val => val == null || val.__isNull;
      const pg2GqlMapper: Pg2GqlMapper = {};
      const pg2gqlForType = type => {
        if (pg2GqlMapper[type.id]) {
          const map = pg2GqlMapper[type.id].map;
          return val => (isNull(val) ? null : map(val));
        } else if (type.domainBaseType) {
          return pg2gqlForType(type.domainBaseType);
        } else if (type.isPgArray) {
          const elementHandler = pg2gqlForType(type.arrayItemType);
          return val => {
            if (isNull(val)) return null;
            if (!Array.isArray(val)) {
              throw new Error(
                `Expected array when converting PostgreSQL data into GraphQL; failing type: '${type.namespaceName}.${type.name}'`
              );
            }
            return val.map(elementHandler);
          };
        } else {
          return identity;
        }
      };
      const pg2gql = (val, type) => pg2gqlForType(type)(val);
      const gql2pg = (val, type, modifier) => {
        if (modifier === undefined) {
          let stack;
          try {
            throw new Error();
          } catch (e) {
            stack = e.stack;
          }
          // eslint-disable-next-line no-console
          console.warn(
            "gql2pg should be called with three arguments, the third being the type modifier (or `null`); " +
              (stack || "")
          );

          // Hack for backwards compatibility:
          modifier = null;
        }
        if (val == null) {
          return sql.null;
        }
        if (pg2GqlMapper[type.id]) {
          return pg2GqlMapper[type.id].unmap(val, modifier);
        } else if (type.domainBaseType) {
          return gql2pg(val, type.domainBaseType, type.domainTypeModifier);
        } else if (type.isPgArray) {
          if (!Array.isArray(val)) {
            throw new Error(
              `Expected array when converting GraphQL data into PostgreSQL data; failing type: '${
                type.namespaceName
              }.${type.name}' (type: ${type === null ? "null" : typeof type})`
            );
          }
          return sql.fragment`array[${sql.join(
            val.map(v => gql2pg(v, type.arrayItemType, modifier)),
            ", "
          )}]::${sql.identifier(type.namespaceName)}.${sql.identifier(
            type.name
          )}`;
        } else {
          return sql.value(val);
        }
      };

      const makeIntervalFields = () => {
        return {
          seconds: {
            description:
              "A quantity of seconds. This is the only non-integer field, as all the other fields will dump their overflow into a smaller unit of time. Intervals don’t have a smaller unit than seconds.",
            type: GraphQLFloat,
          },

          minutes: {
            description: "A quantity of minutes.",
            type: GraphQLInt,
          },

          hours: {
            description: "A quantity of hours.",
            type: GraphQLInt,
          },

          days: {
            description: "A quantity of days.",
            type: GraphQLInt,
          },

          months: {
            description: "A quantity of months.",
            type: GraphQLInt,
          },

          years: {
            description: "A quantity of years.",
            type: GraphQLInt,
          },
        };
      };
      const intervalSpec: GraphileObjectTypeConfig<any, any> = {
        name: inflection.builtin("Interval"),
        description:
          "An interval of time that has passed where the smallest distinct unit is a second.",
        fields: makeIntervalFields(),
      };
      const intervalScope: ScopeGraphQLObjectType = {
        isIntervalType: true,
      };
      const GQLInterval = newWithHooks(
        GraphQLObjectType,
        intervalSpec,
        intervalScope
      );

      if (GQLInterval) {
        addType(GQLInterval, "graphile-build-pg built-in");
      }

      const GQLIntervalInput = newWithHooks(
        GraphQLInputObjectType,
        {
          name: inflection.inputType(inflection.builtin("Interval")),
          description:
            "An interval of time that has passed where the smallest distinct unit is a second.",
          fields: makeIntervalFields(),
        },

        {
          isIntervalInputType: true,
        }
      );

      if (GQLIntervalInput) {
        addType(GQLIntervalInput, "graphile-build-pg built-in");
      }

      const stringType = (name, description) =>
        new GraphQLScalarType({
          name,
          description,
          serialize: value => String(value),
          parseValue: value => String(value),
          parseLiteral: ast => {
            if (ast.kind !== Kind.STRING) {
              throw new Error("Can only parse string values");
            }
            return ast.value;
          },
        });

      const BigFloat = stringType(
        inflection.builtin("BigFloat"),
        "A floating point number that requires more precision than IEEE 754 binary 64"
      );

      const BitString = stringType(
        inflection.builtin("BitString"),
        "A string representing a series of binary bits"
      );

      addType(BigFloat, "graphile-build-pg built-in");
      addType(BitString, "graphile-build-pg built-in");

      const rawTypes = [
        1186, // interval
        1082, // date
        1114, // timestamp
        1184, // timestamptz
        1083, // time
        1266, // timetz
      ];

      const tweakToJson = fragment => fragment; // Since everything is to_json'd now, just pass through
      const tweakToText = fragment => sql.fragment`(${fragment})::text`;
      const tweakToNumericText = fragment =>
        sql.fragment`(${fragment})::numeric::text`;
      const pgTweaksByTypeIdAndModifer = {};
      const pgTweaksByTypeId = {
        // '::text' rawTypes
        ...rawTypes.reduce((memo, typeId) => {
          memo[typeId] = tweakToText;
          return memo;
        }, {}),

        // cast numbers above our ken to strings to avoid loss of precision
        "20": tweakToText,
        "1700": tweakToText,
        // to_json all dates to make them ISO (overrides rawTypes above)
        "1082": tweakToJson,
        "1114": tweakToJson,
        "1184": tweakToJson,
        "1083": tweakToJson,
        "1266": tweakToJson,
        "790": tweakToNumericText,
      };

      const pgTweakFragmentForTypeAndModifier = (
        fragment,
        type,
        typeModifier = null,
        resolveData
      ) => {
        const typeModifierKey = typeModifier != null ? typeModifier : -1;
        const tweaker =
          (pgTweaksByTypeIdAndModifer[type.id] &&
            pgTweaksByTypeIdAndModifer[type.id][typeModifierKey]) ||
          pgTweaksByTypeId[type.id];
        if (tweaker) {
          return tweaker(fragment, resolveData);
        } else if (type.domainBaseType) {
          // TODO: check that domains don't support atttypemod
          return pgTweakFragmentForTypeAndModifier(
            fragment,
            type.domainBaseType,
            type.domainBaseTypeModifier,
            resolveData
          );
        } else if (type.isPgArray) {
          const error = new Error(
            `Internal graphile-build-pg error: should not attempt to tweak an array, please process array before tweaking (type: "${type.namespaceName}.${type.name}")`
          );

          if (process.env.NODE_ENV === "test") {
            // This is to ensure that Graphile core does not introduce these problems
            throw error;
          }
          // eslint-disable-next-line no-console
          console.error(error);
          return fragment;
        } else {
          return fragment;
        }
      };
      /*
       Determined by running:
          select oid, typname, typarray, typcategory, typtype from pg_catalog.pg_type where typtype = 'b' order by oid;
        We only need to add oidLookups for types that don't have the correct fallback
       */

      const SimpleDate = stringType(
        inflection.builtin("Date"),
        "The day, does not include a time."
      );

      const SimpleDatetime = stringType(
        inflection.builtin("Datetime"),
        "A point in time as described by the [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601) standard. May or may not include a timezone."
      );

      const SimpleTime = stringType(
        inflection.builtin("Time"),
        "The exact time of day, does not include the date. May or may not have a timezone offset."
      );

      const SimpleJSON = stringType(
        inflection.builtin("JSON"),
        "A JavaScript object encoded in the JSON format as specified by [ECMA-404](http://www.ecma-international.org/publications/files/ECMA-ST/ECMA-404.pdf)."
      );

      const SimpleUUID = stringType(
        inflection.builtin("UUID"),
        "A universally unique identifier as defined by [RFC 4122](https://tools.ietf.org/html/rfc4122)."
      );

      const InetType = stringType(
        inflection.builtin("InternetAddress"),
        "An IPv4 or IPv6 host address, and optionally its subnet."
      );

      const CidrType = pgUseCustomNetworkScalars
        ? stringType(
            inflection.builtin("CidrAddress"),
            "An IPv4 or IPv6 CIDR address."
          )
        : GraphQLString;
      const MacAddrType = pgUseCustomNetworkScalars
        ? stringType(inflection.builtin("MacAddress"), "A 6-byte MAC address.")
        : GraphQLString;
      const MacAddr8Type = pgUseCustomNetworkScalars
        ? stringType(
            inflection.builtin("MacAddress8"),
            "An 8-byte MAC address."
          )
        : GraphQLString;

      // pgExtendedTypes might change what types we use for things
      const JSONType = pgExtendedTypes
        ? makeGraphQLJSONType(graphql, inflection.builtin("JSON"))
        : SimpleJSON;
      const UUIDType = SimpleUUID; // GraphQLUUID
      const DateType = SimpleDate; // GraphQLDate
      const DateTimeType = SimpleDatetime; // GraphQLDateTime
      const TimeType = SimpleTime; // GraphQLTime

      // 'point' in PostgreSQL is a 16-byte type that's comprised of two 8-byte floats.
      const Point = newWithHooks(
        GraphQLObjectType,
        {
          name: inflection.builtin("Point"),
          fields: {
            x: {
              type: new GraphQLNonNull(GraphQLFloat),
            },

            y: {
              type: new GraphQLNonNull(GraphQLFloat),
            },
          },
        },

        {
          isPointType: true,
        }
      );

      const PointInput = newWithHooks(
        GraphQLInputObjectType,
        {
          name: inflection.inputType(inflection.builtin("Point")),
          fields: {
            x: {
              type: new GraphQLNonNull(GraphQLFloat),
            },

            y: {
              type: new GraphQLNonNull(GraphQLFloat),
            },
          },
        },

        {
          isPointInputType: true,
        }
      );

      // Other plugins might want to use JSON
      addType(JSONType, "graphile-build-pg built-in");
      addType(UUIDType, "graphile-build-pg built-in");
      addType(DateType, "graphile-build-pg built-in");
      addType(DateTimeType, "graphile-build-pg built-in");
      addType(TimeType, "graphile-build-pg built-in");

      const oidLookup = {
        "20": stringType(
          inflection.builtin("BigInt"),
          "A signed eight-byte integer. The upper big integer values are greater than the max value for a JavaScript number. Therefore all big integers will be output as strings and not numbers."
        ),
        // bitint - even though this is int8, it's too big for JS int, so cast to string.
        "21": GraphQLInt, // int2
        "23": GraphQLInt, // int4
        "700": GraphQLFloat, // float4
        "701": GraphQLFloat, // float8
        "1700": BigFloat, // numeric
        "790": GraphQLFloat, // money

        "1186": GQLInterval, // interval
        "1082": DateType, // date
        "1114": DateTimeType, // timestamp
        "1184": DateTimeType, // timestamptz
        "1083": TimeType, // time
        "1266": TimeType, // timetz

        "114": JSONType, // json
        "3802": JSONType, // jsonb
        "2950": UUIDType, // uuid

        "1560": BitString, // bit
        "1562": BitString, // varbit

        "18": GraphQLString, // char
        "25": GraphQLString, // text
        "1043": GraphQLString, // varchar

        "600": Point, // point

        "869": InetType,
        "650": CidrType,
        "829": MacAddrType,
        "774": MacAddr8Type,
      };

      const oidInputLookup = {
        "1186": GQLIntervalInput, // interval
        "600": PointInput, // point
      };
      const jsonStringify = o => JSON.stringify(o);
      if (pgExtendedTypes) {
        pg2GqlMapper[114] = {
          map: identity,
          unmap: o => sql.value(jsonStringify(o)),
        };
      } else {
        pg2GqlMapper[114] = {
          map: jsonStringify,
          unmap: str => sql.value(str),
        };
      }
      pg2GqlMapper[3802] = pg2GqlMapper[114]; // jsonb

      // interval
      pg2GqlMapper[1186] = {
        map: str => parseInterval(str),
        unmap: o => {
          const keys = [
            "seconds",
            "minutes",
            "hours",
            "days",
            "months",
            "years",
          ];

          const parts: string[] = [];
          for (const key of keys) {
            if (o[key]) {
              parts.push(`${o[key]} ${key}`);
            }
          }
          return sql.value(parts.join(" ") || "0 seconds");
        },
      };

      pg2GqlMapper[790] = {
        map: _ => _,
        unmap: val => sql.fragment`(${sql.value(val)})::money`,
      };

      // point
      pg2GqlMapper[600] = {
        map: f => {
          if (f[0] === "(" && f[f.length - 1] === ")") {
            const [x, y] = f
              .substr(1, f.length - 2)
              .split(",")
              .map(f => parseFloat(f));
            return { x, y };
          }
        },
        unmap: o => sql.fragment`point(${sql.value(o.x)}, ${sql.value(o.y)})`,
      };

      // TODO: add more support for geometric types

      let depth = 0;

      /*
       * Enforce: this is the fallback when we can't find a specific GraphQL type
       * for a specific PG type.  Use the generators from
       * `pgRegisterGqlTypeByTypeId` first, this is a last resort.
       */
      const enforceGqlTypeByPgTypeId = (typeId, typeModifier) => {
        const type = introspectionResultsByKind.type.find(t => t.id === typeId);
        if (!type) {
          throw new Error(
            `Could not find type with oid '${typeId}' in the introspection results`
          );
        }
        depth++;
        if (depth > 50) {
          throw new Error("Type enforcement went too deep - infinite loop?");
        }
        try {
          return reallyEnforceGqlTypeByPgTypeAndModifier(type, typeModifier);
        } catch (e) {
          const error = new Error(
            `Error occurred when processing database type '${
              type.namespaceName
            }.${type.name}' (type=${type.type}):\n${indent(e.message)}`
          );

          error["originalError"] = e;
          throw error;
        } finally {
          depth--;
        }
      };
      const reallyEnforceGqlTypeByPgTypeAndModifier = (type, typeModifier) => {
        if (!type.id) {
          throw new Error(
            `Invalid argument to enforceGqlTypeByPgTypeId - expected a full type, received '${type}'`
          );
        }
        if (!gqlTypeByTypeIdAndModifier[type.id]) {
          gqlTypeByTypeIdAndModifier[type.id] = {};
        }
        if (!gqlInputTypeByTypeIdAndModifier[type.id]) {
          gqlInputTypeByTypeIdAndModifier[type.id] = {};
        }
        const typeModifierKey = typeModifier != null ? typeModifier : -1;
        // Explicit overrides
        if (!gqlTypeByTypeIdAndModifier[type.id][typeModifierKey]) {
          const gqlType = oidLookup[type.id];
          if (gqlType) {
            gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] = gqlType;
          }
        }
        if (!gqlInputTypeByTypeIdAndModifier[type.id][typeModifierKey]) {
          const gqlInputType = oidInputLookup[type.id];
          if (gqlInputType) {
            gqlInputTypeByTypeIdAndModifier[type.id][
              typeModifierKey
            ] = gqlInputType;
          }
        }
        // Enums
        if (
          !gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] &&
          type.type === "e"
        ) {
          const enumType = newWithHooks(
            GraphQLEnumType,
            {
              name: inflection.enumType(type),
              description: type.description,
              values: type.enumVariants.reduce((memo, value) => {
                memo[inflection.enumName(value)] = {
                  value: value,
                };

                return memo;
              }, {}),
            },

            {
              pgIntrospection: type,
              isPgEnumType: true,
            }
          );
          if (enumType) {
            gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] = enumType;
          }
        }
        // Ranges
        if (
          !gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] &&
          type.type === "r"
        ) {
          const subtype =
            introspectionResultsByKind.typeById[type.rangeSubTypeId];
          const gqlRangeSubType = getGqlTypeByTypeIdAndModifier(
            subtype.id,
            typeModifier
          );

          if (!gqlRangeSubType) {
            throw new Error("Range of unsupported");
          }
          let existingRange = getTypeByName(
            inflection.rangeType(gqlRangeSubType.name)
          );
          let Range: GraphQLObjectType<any, any> | null | undefined =
            existingRange && existingRange instanceof GraphQLObjectType
              ? existingRange
              : null;
          let RangeInput;
          if (!Range) {
            const rangeBoundSpec: GraphileObjectTypeConfig<any, any> = {
              name: inflection.rangeBoundType(gqlRangeSubType.name),
              description:
                "The value at one end of a range. A range can either include this value, or not.",
              fields: {
                value: {
                  description: "The value at one end of our range.",
                  type: new GraphQLNonNull(gqlRangeSubType),
                },

                inclusive: {
                  description:
                    "Whether or not the value of this bound is included in the range.",
                  type: new GraphQLNonNull(GraphQLBoolean),
                },
              },
            };
            const RangeBound = newWithHooks(
              GraphQLObjectType,
              rangeBoundSpec,

              {
                isPgRangeBoundType: true,
                pgIntrospection: type,
                pgSubtypeIntrospection: subtype,
                pgTypeModifier: typeModifier,
              }
            );

            if (!RangeBound) {
              throw new Error(
                `Failed to construct RangeBound type '${rangeBoundSpec.name}'`
              );
            }

            const rangeBoundInputSpec: GraphileInputObjectTypeConfig = {
              name: inflection.inputType(RangeBound.name),
              description:
                "The value at one end of a range. A range can either include this value, or not.",
              fields: {
                value: {
                  description: "The value at one end of our range.",
                  type: new GraphQLNonNull(gqlRangeSubType),
                },

                inclusive: {
                  description:
                    "Whether or not the value of this bound is included in the range.",
                  type: new GraphQLNonNull(GraphQLBoolean),
                },
              },
            };
            const RangeBoundInput = newWithHooks(
              GraphQLInputObjectType,
              rangeBoundInputSpec,

              {
                isPgRangeBoundInputType: true,
                pgIntrospection: type,
                pgSubtypeIntrospection: subtype,
                pgTypeModifier: typeModifier,
              }
            );
            if (!RangeBoundInput) {
              throw new Error(
                `Failed to construct RangeBoundInput type '${rangeBoundInputSpec.name}'`
              );
            }

            const rangeSpec: GraphileObjectTypeConfig<any, any> = {
              name: inflection.rangeType(gqlRangeSubType.name),
              description: `A range of \`${gqlRangeSubType.name}\`.`,
              fields: {
                start: {
                  description: "The starting bound of our range.",
                  type: RangeBound,
                },

                end: {
                  description: "The ending bound of our range.",
                  type: RangeBound,
                },
              },
            };
            const rangeScope: ScopeGraphQLObjectType = {
              isPgRangeType: true,
              pgIntrospection: type,
              pgSubtypeIntrospection: subtype,
              pgTypeModifier: typeModifier,
            };
            Range = newWithHooks(GraphQLObjectType, rangeSpec, rangeScope);
            if (!Range) {
              throw new Error(
                `Failed to construct range type '${rangeSpec.name}'`
              );
            }

            const rangeInputSpec: GraphileInputObjectTypeConfig = {
              name: inflection.inputType(Range.name),
              description: `A range of \`${gqlRangeSubType.name}\`.`,
              fields: {
                start: {
                  description: "The starting bound of our range.",
                  type: RangeBoundInput,
                },

                end: {
                  description: "The ending bound of our range.",
                  type: RangeBoundInput,
                },
              },
            };
            RangeInput = newWithHooks(
              GraphQLInputObjectType,
              rangeInputSpec,

              {
                isPgRangeInputType: true,
                pgIntrospection: type,
                pgSubtypeIntrospection: subtype,
                pgTypeModifier: typeModifier,
              }
            );

            addType(Range, "graphile-build-pg built-in");
            addType(RangeInput, "graphile-build-pg built-in");
          } else {
            RangeInput = getTypeByName(inflection.inputType(Range.name));
          }
          gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] = Range;
          gqlInputTypeByTypeIdAndModifier[type.id][
            typeModifierKey
          ] = RangeInput;
          if (pgTweaksByTypeIdAndModifer[type.id] === undefined) {
            pgTweaksByTypeIdAndModifer[type.id] = {};
          }
          pgTweaksByTypeIdAndModifer[type.id][
            typeModifierKey
          ] = fragment => sql.fragment`\
case
when (${fragment}) is null then null
else json_build_object(
  'start',
  case when lower(${fragment}) is null then null
  else json_build_object('value', ${pgTweakFragmentForTypeAndModifier(
    sql.fragment`lower(${fragment})`,
    subtype,
    typeModifier,
    {}
  )}, 'inclusive', lower_inc(${fragment}))
  end,
  'end',
  case when upper(${fragment}) is null then null
  else json_build_object('value', ${pgTweakFragmentForTypeAndModifier(
    sql.fragment`upper(${fragment})`,
    subtype,
    typeModifier,
    {}
  )}, 'inclusive', upper_inc(${fragment}))
  end
)
end`;
          pg2GqlMapper[type.id] = {
            map: identity,
            unmap: ({ start, end }) => {
              // Ref: https://www.postgresql.org/docs/9.6/static/rangetypes.html#RANGETYPES-CONSTRUCT
              const lower =
                (start && gql2pg(start.value, subtype, null)) || sql.null;
              const upper =
                (end && gql2pg(end.value, subtype, null)) || sql.null;
              const lowerInclusive = start && !start.inclusive ? "(" : "[";
              const upperInclusive = end && !end.inclusive ? ")" : "]";
              return sql.fragment`${sql.identifier(
                type.namespaceName,
                type.name
              )}(${lower}, ${upper}, ${sql.literal(
                lowerInclusive + upperInclusive
              )})`;
            },
          };
        }

        // Domains
        if (
          !gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] &&
          type.type === "d" &&
          type.domainBaseTypeId
        ) {
          const baseType = getGqlTypeByTypeIdAndModifier(
            type.domainBaseTypeId,
            typeModifier
          );

          const baseInputType =
            gqlInputTypeByTypeIdAndModifier[type.domainBaseTypeId][
              typeModifierKey
            ];

          // Hack stolen from: https://github.com/graphile/postgraphile/blob/ade728ed8f8e3ecdc5fdad7d770c67aa573578eb/src/graphql/schema/type/aliasGqlType.ts#L16
          gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] = Object.assign(
            Object.create(baseType),
            {
              name: inflection.domainType(type),
              description: type.description,
            }
          );

          if (baseInputType && baseInputType !== baseType) {
            gqlInputTypeByTypeIdAndModifier[type.id][
              typeModifierKey
            ] = Object.assign(Object.create(baseInputType), {
              name: inflection.inputType(
                getNamedType(
                  gqlTypeByTypeIdAndModifier[type.id][typeModifierKey]
                ).name
              ),

              description: type.description,
            });
          }
        }

        // Arrays
        if (
          !gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] &&
          type.category === "A"
        ) {
          const arrayEntryOutputType = getGqlTypeByTypeIdAndModifier(
            type.arrayItemTypeId,
            typeModifier
          );

          gqlTypeByTypeIdAndModifier[type.id][
            typeModifierKey
          ] = new GraphQLList(arrayEntryOutputType);
          if (!disableIssue390Fix) {
            const arrayEntryInputType = getGqlInputTypeByTypeIdAndModifier(
              type.arrayItemTypeId,
              typeModifier
            );

            if (arrayEntryInputType) {
              gqlInputTypeByTypeIdAndModifier[type.id][
                typeModifierKey
              ] = new GraphQLList(arrayEntryInputType);
            }
          }
        }

        // Booleans
        if (
          !gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] &&
          type.category === "B"
        ) {
          gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] = GraphQLBoolean;
        }

        // Numbers may be too large for GraphQL/JS to handle, so stringify by
        // default.
        if (
          !gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] &&
          type.category === "N"
        ) {
          pgTweaksByTypeId[type.id] = tweakToText;
          gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] = BigFloat;
        }

        // Nothing else worked; pass through as string!
        if (!gqlTypeByTypeIdAndModifier[type.id][typeModifierKey]) {
          // XXX: consider using stringType(upperFirst(camelCase(`fallback_${type.name}`)), type.description)?
          gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] = GraphQLString;
        }
        // Now for input types, fall back to output types if possible
        if (!gqlInputTypeByTypeIdAndModifier[type.id][typeModifierKey]) {
          const t = gqlTypeByTypeIdAndModifier[type.id][typeModifierKey];
          if (isInputType(t)) {
            gqlInputTypeByTypeIdAndModifier[type.id][typeModifierKey] = t;
          }
        }
        addType(
          getNamedType(gqlTypeByTypeIdAndModifier[type.id][typeModifierKey]),
          "reallyEnforceGqlTypeByPgTypeAndModifier"
        );

        return gqlTypeByTypeIdAndModifier[type.id][typeModifierKey];
      };

      function getGqlTypeByTypeIdAndModifier(
        typeId,
        typeModifier: string | null = null,
        useFallback = true
      ) {
        const typeModifierKey = typeModifier != null ? typeModifier : -1;
        if (!gqlTypeByTypeIdAndModifier[typeId]) {
          gqlTypeByTypeIdAndModifier[typeId] = {};
        }
        if (!gqlInputTypeByTypeIdAndModifier[typeId]) {
          gqlInputTypeByTypeIdAndModifier[typeId] = {};
        }
        if (!gqlTypeByTypeIdAndModifier[typeId][typeModifierKey]) {
          const type = introspectionResultsByKind.type.find(
            t => t.id === typeId
          );

          if (!type) {
            throw new Error(
              `Type '${typeId}' not present in introspection results`
            );
          }
          const gen = gqlTypeByTypeIdGenerator[type.id];
          if (gen) {
            const set = Type => {
              gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] = Type;
            };
            const result = gen(set, typeModifier);
            if (result) {
              if (
                gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] &&
                gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] !== result
              ) {
                throw new Error(
                  `Callback and return types differ when defining type for '${type.id}'`
                );
              }
              gqlTypeByTypeIdAndModifier[type.id][typeModifierKey] = result;
            }
          }
        }
        if (
          !gqlTypeByTypeIdAndModifier[typeId][typeModifierKey] &&
          typeModifierKey > -1
        ) {
          // Fall back to `null` modifier, but if that still doesn't work, we
          // still want to pass the modifier to enforceGqlTypeByPgTypeId.
          const fallback = getGqlTypeByTypeIdAndModifier(typeId, null, false);
          if (fallback) {
            return fallback;
          }
        }
        if (
          useFallback &&
          !gqlTypeByTypeIdAndModifier[typeId][typeModifierKey]
        ) {
          return enforceGqlTypeByPgTypeId(typeId, typeModifier);
        }
        return gqlTypeByTypeIdAndModifier[typeId][typeModifierKey];
      }

      function getGqlInputTypeByTypeIdAndModifier(
        typeId,
        typeModifier: string | null = null
      ) {
        // First, load the OUTPUT type (it might register an input type)
        getGqlTypeByTypeIdAndModifier(typeId, typeModifier);

        const typeModifierKey = typeModifier != null ? typeModifier : -1;
        if (!gqlInputTypeByTypeIdAndModifier[typeId]) {
          gqlInputTypeByTypeIdAndModifier[typeId] = {};
        }
        if (!gqlInputTypeByTypeIdAndModifier[typeId][typeModifierKey]) {
          const type = introspectionResultsByKind.typeById[typeId];

          if (!type) {
            throw new Error(
              `Type '${typeId}' not present in introspection results`
            );
          }
          const gen = gqlInputTypeByTypeIdGenerator[type.id];
          if (gen) {
            const set = Type => {
              gqlInputTypeByTypeIdAndModifier[type.id][typeModifierKey] = Type;
            };
            const result = gen(set, typeModifier);
            if (result) {
              if (
                gqlInputTypeByTypeIdAndModifier[type.id][typeModifierKey] &&
                gqlInputTypeByTypeIdAndModifier[type.id][typeModifierKey] !==
                  result
              ) {
                throw new Error(
                  `Callback and return types differ when defining type for '${type.id}'`
                );
              }
              gqlInputTypeByTypeIdAndModifier[type.id][
                typeModifierKey
              ] = result;
            }
          }
        }
        // Use the same type as the output type if it's valid input
        const t =
          gqlTypeByTypeIdAndModifier[typeId] &&
          gqlTypeByTypeIdAndModifier[typeId][typeModifierKey];
        if (
          !gqlInputTypeByTypeIdAndModifier[typeId][typeModifierKey] &&
          t &&
          isInputType(t)
        ) {
          gqlInputTypeByTypeIdAndModifier[typeId][typeModifierKey] = t;
        }
        if (
          !gqlInputTypeByTypeIdAndModifier[typeId][typeModifierKey] &&
          typeModifierKey > -1
        ) {
          // Fall back to default
          return getGqlInputTypeByTypeIdAndModifier(typeId, null);
        }
        return gqlInputTypeByTypeIdAndModifier[typeId][typeModifierKey];
      }
      function registerGqlTypeByTypeId(typeId, gen, yieldToExisting = false) {
        if (gqlTypeByTypeIdGenerator[typeId]) {
          if (yieldToExisting) {
            return;
          }
          throw new Error(
            `There's already a type generator registered for '${typeId}'`
          );
        }
        gqlTypeByTypeIdGenerator[typeId] = gen;
      }
      function registerGqlInputTypeByTypeId(
        typeId,
        gen,
        yieldToExisting = false
      ) {
        if (gqlInputTypeByTypeIdGenerator[typeId]) {
          if (yieldToExisting) {
            return;
          }
          throw new Error(
            `There's already an input type generator registered for '${typeId}'`
          );
        }
        gqlInputTypeByTypeIdGenerator[typeId] = gen;
      }

      // DEPRECATIONS!
      function getGqlTypeByTypeId(typeId, typeModifier) {
        if (typeModifier === undefined) {
          // eslint-disable-next-line no-console
          console.warn(
            "DEPRECATION WARNING: getGqlTypeByTypeId should not be used - for some columns we also require typeModifier to be specified. Please update your code ASAP to pass `attribute.typeModifier` through as the second parameter (or null if it's not available)."
          );
        }
        return getGqlTypeByTypeIdAndModifier(typeId, typeModifier);
      }
      function getGqlInputTypeByTypeId(typeId, typeModifier) {
        if (typeModifier === undefined) {
          // eslint-disable-next-line no-console
          console.warn(
            "DEPRECATION WARNING: getGqlInputTypeByTypeId should not be used - for some columns we also require typeModifier to be specified. Please update your code ASAP to pass `attribute.typeModifier` through as the second parameter (or null if it's not available)."
          );
        }
        return getGqlInputTypeByTypeIdAndModifier(typeId, typeModifier);
      }
      function pgTweakFragmentForType(
        fragment,
        type,
        typeModifier,
        resolveData
      ) {
        if (typeModifier === undefined) {
          // eslint-disable-next-line no-console
          console.warn(
            "DEPRECATION WARNING: pgTweakFragmentForType should not be used - for some columns we also require typeModifier to be specified. Please update your code ASAP to pass `attribute.typeModifier` through as the third parameter (or null if it's not available)."
          );
        }
        return pgTweakFragmentForTypeAndModifier(
          fragment,
          type,
          typeModifier,
          resolveData
        );
      }
      // END OF DEPRECATIONS!

      const buildExtension: Partial<Build> = {
        pgRegisterGqlTypeByTypeId: registerGqlTypeByTypeId,
        pgRegisterGqlInputTypeByTypeId: registerGqlInputTypeByTypeId,
        pgGetGqlTypeByTypeIdAndModifier: getGqlTypeByTypeIdAndModifier,
        pgGetGqlInputTypeByTypeIdAndModifier: getGqlInputTypeByTypeIdAndModifier,
        pg2GqlMapper,
        pg2gql,
        pg2gqlForType,
        gql2pg,
        pgTweakFragmentForTypeAndModifier,
        pgTweaksByTypeId,
        pgTweaksByTypeIdAndModifer,
      };

      // DEPRECATED METHODS:
      Object.assign(buildExtension, {
        pgGetGqlTypeByTypeId: getGqlTypeByTypeId, // DEPRECATED, replaced by getGqlTypeByTypeIdAndModifier
        pgGetGqlInputTypeByTypeId: getGqlInputTypeByTypeId, // DEPRECATED, replaced by getGqlInputTypeByTypeIdAndModifier
        pgTweakFragmentForType, // DEPRECATED, replaced by pgTweakFragmentForTypeAndModifier
      } as any);

      return build.extend(
        build,
        buildExtension,
        "Adding type helpers from PgTypesPlugin"
      );
    },
    ["PgTypes"],
    [],
    ["PgIntrospection", "StandardTypes"]
  );

  /* Start of hstore type */
  builder.hook(
    "inflection",
    (inflection, build) => {
      // This hook allows you to append a plugin which renames the KeyValueHash
      // (hstore) type name.
      if (pgSkipHstore) return inflection;
      const newInflectors: Partial<Inflection> = {
        hstoreType() {
          return "KeyValueHash";
        },
      };
      return build.extend(inflection, newInflectors, "hstore inflector");
    },
    ["PgTypesHstore"]
  );

  builder.hook(
    "build",
    build => {
      // This hook tells graphile-build-pg about the hstore database type so it
      // knows how to express it in input/output.
      if (pgSkipHstore) return build;
      const {
        pgIntrospectionResultsByKind: rawIntrospectionResultsByKind,
        pgRegisterGqlTypeByTypeId,
        pgRegisterGqlInputTypeByTypeId,
        pg2GqlMapper,
        pgSql: sql,
        graphql,
      } = build;

      if (
        !rawIntrospectionResultsByKind ||
        !sql ||
        !pgRegisterGqlTypeByTypeId ||
        !pgRegisterGqlInputTypeByTypeId ||
        !pg2GqlMapper
      ) {
        throw new Error("Required helpers were not found on Build.");
      }

      const introspectionResultsByKind = rawIntrospectionResultsByKind;

      // Check we have the hstore extension
      const hstoreExtension = introspectionResultsByKind.extension.find(
        e => e.name === "hstore"
      );

      if (!hstoreExtension) {
        return build;
      }

      // Get the 'hstore' type itself:
      const hstoreType = introspectionResultsByKind.type.find(
        t =>
          t.name === "hstore" && t.namespaceId === hstoreExtension.namespaceId
      );

      if (!hstoreType) {
        return build;
      }

      const hstoreTypeName = build.inflection.hstoreType();

      // We're going to use our own special HStore type for this so that we get
      // better validation; but you could just as easily use JSON directly if you
      // wanted to.
      const GraphQLHStoreType = makeGraphQLHstoreType(graphql, hstoreTypeName);

      // Now register the hstore type with the type system for both output and input.
      pgRegisterGqlTypeByTypeId(hstoreType.id, () => GraphQLHStoreType);
      pgRegisterGqlInputTypeByTypeId(hstoreType.id, () => GraphQLHStoreType);

      // Finally we must tell the system how to translate the data between PG-land and JS-land:
      pg2GqlMapper[hstoreType.id] = {
        // node-postgres parses hstore for us, no action required on map
        map: identity,
        // When unmapping we need to convert back to hstore
        unmap: o =>
          sql.fragment`(${sql.value(hstoreStringify(o))}::${sql.identifier(
            hstoreType.namespaceName,
            hstoreType.name
          )})`,
      };

      return build;
    },
    ["PgTypesHstore"],
    [],
    ["PgTypes"]
  );

  /* End of hstore type */
} as Plugin);

function makeGraphQLHstoreType(graphql, hstoreTypeName) {
  const { GraphQLScalarType, Kind } = graphql;

  function isValidHstoreObject(obj) {
    if (obj === null) {
      // Null is okay
      return true;
    } else if (typeof obj === "object") {
      // A hash with string/null values is also okay
      const keys = Object.keys(obj);
      for (const key of keys) {
        const val = obj[key];
        if (val === null) {
          // Null is okay
        } else if (typeof val === "string") {
          // String is okay
        } else {
          // Everything else is invalid.
          return false;
        }
      }
      return true;
    } else {
      // Everything else is invalid.
      return false;
    }
  }

  function identityWithCheck(obj) {
    if (isValidHstoreObject(obj)) {
      return obj;
    }
    throw new TypeError(
      `This is not a valid ${hstoreTypeName} object, it must be a key/value hash where keys and values are both strings (or null).`
    );
  }

  function parseValueLiteral(ast, variables) {
    switch (ast.kind) {
      case Kind.INT:
      case Kind.FLOAT:
        // Number isn't really okay, but we'll coerce it to a string anyway.
        return String(parseFloat(ast.value));
      case Kind.STRING:
        // String is okay.
        return String(ast.value);
      case Kind.NULL:
        // Null is okay.
        return null;
      case Kind.VARIABLE: {
        // Variable is okay if that variable is either a string or null.
        const name = ast.name.value;
        const value = variables ? variables[name] : undefined;
        if (value === null || typeof value === "string") {
          return value;
        }
        return undefined;
      }
      default:
        // Everything else is invalid.
        return undefined;
    }
  }

  function parseLiteral(ast, variables) {
    switch (ast.kind) {
      case Kind.OBJECT: {
        const value = ast.fields.reduce((memo, field) => {
          memo[field.name.value] = parseValueLiteral(field.value, variables);
          return memo;
        }, Object.create(null));

        if (!isValidHstoreObject(value)) {
          return undefined;
        }
        return value;
      }

      case Kind.NULL:
        return null;

      case Kind.VARIABLE: {
        const name = ast.name.value;
        const value = variables ? variables[name] : undefined;

        if (!isValidHstoreObject(value)) {
          return undefined;
        }
        return value;
      }

      default:
        return undefined;
    }
  }

  // TODO: use newWithHooks instead
  const GraphQLHStore = new GraphQLScalarType({
    name: hstoreTypeName,
    description:
      "A set of key/value pairs, keys are strings, values may be a string or null. Exposed as a JSON object.",
    serialize: identity,
    parseValue: identityWithCheck,
    parseLiteral,
  });

  return GraphQLHStore;
}

// To include a double quote or a backslash in a key or value, escape it
// with a backslash.
// -- https://www.postgresql.org/docs/10/static/hstore.html
function toHstoreString(str) {
  return '"' + str.replace(/(["\\])/g, "\\$1") + '"';
}

function hstoreStringify(o) {
  if (o === null) {
    return null;
  }
  if (typeof o !== "object") {
    throw new TypeError("Expected an hstore object");
  }
  const keys = Object.keys(o);
  const encodeKeyValue = key => {
    const value = o[key];
    if (value === null) {
      return `${toHstoreString(key)} => NULL`;
    } else {
      return `${toHstoreString(key)} => ${toHstoreString(String(value))}`;
    }
  };
  return keys.map(encodeKeyValue).join(", ");
}
