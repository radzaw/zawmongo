// What a shell statement does, as far as the confirmations need to know: whether it changes anything, and whether
// it changes every document of a collection (an empty filter). The backend's read-only guard is the real check.

const WRITE_METHOD = /\.\s*(insert(One|Many)?|update(One|Many)?|replaceOne|delete(One|Many)|remove|findOneAnd(Update|Replace|Delete)|bulkWrite|drop|dropIndex(es)?|createIndex(es)?|ensureIndex|renameCollection|createCollection|createView|dropDatabase|createUser|updateUser|dropUser|grantRolesToUser|revokeRolesFromUser|killOp|setProfilingLevel)\s*\(/;
const READ_COMMANDS = /^\s*\{\s*["']?(find|aggregate|count|distinct|listCollections|listDatabases|listIndexes|collStats|dbStats|dataSize|serverStatus|buildInfo|hostInfo|ping|isMaster|hello|connectionStatus|currentOp|getParameter|getCmdLineOpts|replSetGetStatus|replSetGetConfig|usersInfo|rolesInfo|explain|getLog|top|listCommands|whatsmyuri|validate|dbHash)["']?\s*:/i;

/** Strips strings and comments so words inside them don't count. */
function code(s) {
  return s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ').replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, m => (/^["']\$(out|merge)["']$/.test(m) ? m : '""'));
}

/** Does the statement (possibly) change data, indexes, users or the server? */
export function isWrite(stmt) {
  const c = code(stmt);
  if (WRITE_METHOD.test(c)) return true;
  if (/\$(out|merge)\b/.test(c)) return true;
  const cmd = /\.\s*(runCommand|adminCommand)\s*\(([\s\S]*)\)\s*$/.exec(stmt.trim());
  if (cmd) return !READ_COMMANDS.test(cmd[2]) && !/^\s*["'](ping|serverStatus|buildInfo|hostInfo|listCommands|dbStats|connectionStatus)["']\s*$/.test(cmd[2]);
  return false;
}

/** Does it update or delete every document (updateMany({}, …), deleteMany({}), remove({}))? */
export function changesAll(stmt) {
  return /\.\s*(updateMany|deleteMany|remove|update)\s*\(\s*\{\s*\}/.test(code(stmt));
}
