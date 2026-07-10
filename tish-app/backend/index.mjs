import pg from 'pg';
const { Pool } = pg;

// Credentials come exclusively from Lambda environment variables — never
// hardcode fallbacks here: this file is committed to a repo with a remote,
// so anything written below is effectively published.
let pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 5432,
    ssl: { rejectUnauthorized: false }
});

// Test seam: lets index.test.mjs substitute a scripted pool so the handler
// can be exercised functionally without a database connection.
export function _setPoolForTests(fakePool) { pool = fakePool; }

const SCHEMA_SQL = `
    DROP TABLE IF EXISTS user_relationships CASCADE;
    DROP TABLE IF EXISTS test_results CASCADE;
    DROP TABLE IF EXISTS test_config CASCADE;
    DROP TABLE IF EXISTS announcements CASCADE;
    DROP TABLE IF EXISTS appointments CASCADE;
    DROP TABLE IF EXISTS appointment_statuses CASCADE;
    DROP TABLE IF EXISTS medications CASCADE;
    DROP TABLE IF EXISTS medication_reminders CASCADE;
    DROP TABLE IF EXISTS medication_library CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
    DROP TABLE IF EXISTS genders CASCADE;
    DROP TABLE IF EXISTS conditions CASCADE;
    DROP TABLE IF EXISTS invitations CASCADE;

    CREATE TABLE genders (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE conditions (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT);

    CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        cognito_id UUID UNIQUE NOT NULL,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        phone_number TEXT UNIQUE,
        role TEXT,
        full_name TEXT,
        birth_date DATE,
        gender_id INTEGER REFERENCES genders(id),
        condition_id INTEGER REFERENCES conditions(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE user_relationships (
        id SERIAL PRIMARY KEY,
        caregiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        dependent_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        relationship_type TEXT,
        status TEXT DEFAULT 'pending',
        verification_code TEXT,
        UNIQUE(caregiver_id, dependent_id)
    );

    CREATE TABLE medication_library (id SERIAL PRIMARY KEY, name TEXT NOT NULL, default_dosage TEXT NOT NULL);

    CREATE TABLE medication_reminders (
        id SERIAL PRIMARY KEY, 
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, 
        med_id INTEGER REFERENCES medication_library(id),
        selected_dosage TEXT, 
        at_breakfast BOOLEAN DEFAULT false, 
        breakfast_timing TEXT DEFAULT 'after',
        at_lunch BOOLEAN DEFAULT false, 
        lunch_timing TEXT DEFAULT 'after',
        at_dinner BOOLEAN DEFAULT false, 
        dinner_timing TEXT DEFAULT 'after',
        at_bedtime BOOLEAN DEFAULT false, 
        frequency_days INTEGER DEFAULT 1, 
        status TEXT DEFAULT 'active',
        reminder_sound TEXT DEFAULT 'default',
        alarms TEXT[],
        alarm_labels TEXT[]
    );

    CREATE TABLE appointment_statuses (id SERIAL PRIMARY KEY, label TEXT UNIQUE NOT NULL, color TEXT);

    CREATE TABLE appointments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        appointment_date TIMESTAMP WITH TIME ZONE NOT NULL,
        doctor_name TEXT,
        title TEXT NOT NULL,
        hospital TEXT,
        department TEXT,
        room_number TEXT,
        appointment_number TEXT,
        details TEXT,
        status_id INTEGER REFERENCES appointment_statuses(id) DEFAULT 1
    );

    CREATE TABLE announcements (id SERIAL PRIMARY KEY, title TEXT, content TEXT, type TEXT DEFAULT 'news');
    CREATE TABLE test_config (field_number INTEGER PRIMARY KEY, display_name TEXT NOT NULL, units TEXT, description TEXT);

    CREATE TABLE test_results (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        test_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        field_1 NUMERIC, field_2 NUMERIC, field_3 NUMERIC, field_4 NUMERIC, field_5 NUMERIC,
        field_6 NUMERIC, field_7 NUMERIC, field_8 NUMERIC, field_9 NUMERIC, field_10 NUMERIC,
        field_11 NUMERIC, field_12 NUMERIC, field_13 NUMERIC, field_14 NUMERIC, field_15 NUMERIC,
        field_16 NUMERIC, field_17 NUMERIC, field_18 NUMERIC, field_19 NUMERIC, field_20 NUMERIC,
        field_21 NUMERIC, field_22 NUMERIC, field_23 NUMERIC, field_24 NUMERIC, field_25 NUMERIC,
        field_26 NUMERIC, field_27 NUMERIC, field_28 NUMERIC, field_29 NUMERIC, field_30 NUMERIC
    );
`;

const SEED_SQL = `
    INSERT INTO genders (name) VALUES ('Male'), ('Female'), ('Non-binary'), ('Prefer not to say');
    INSERT INTO conditions (name) VALUES ('Acute Mission Stress'), ('Telepathic Overload'), ('Thorn Toxicity'), ('General Wellness');
    INSERT INTO appointment_statuses (id, label, color) VALUES (1, 'New', '#6366F1'), (2, 'Cancelled', '#EF4444'), (3, 'Missed', '#F59E0B'), (4, 'Completed', '#22C55E');
    INSERT INTO medication_library (name, default_dosage) VALUES ('Anti-Telepathy Serum', '200mg, 500mg'), ('High-Grade Peanut Extract', '30mg'), ('Starlight Stamina Mints', '5mg');
    INSERT INTO test_config (field_number, display_name, units) VALUES (1, 'Starlight Level', 'g/dL'), (2, 'Reflex Factor', 'ms'), (3, 'Telepathy Wave', 'Hz');
`;

export const handler = async (event) => {
    

    console.log("event.path: " + event.path);
    console.log("event.rawPath: " + event.rawPath);

    //const path = event.rawPath || "/";

    const fullPath = event.path ?? event.rawPath;
    
    const path = event.pathParameters?.proxy 
                 ? `/${event.pathParameters.proxy}` 
                 : fullPath;

    const method = event.requestContext?.http?.method || event.httpMethod;
    const payload = event.body ? JSON.parse(event.body) : null;
    const queryParams = event.queryStringParameters || {};

    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'OPTIONS, POST, GET, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    console.log("method+path: " + method + " " + path)

    if (method === 'OPTIONS') return { statusCode: 204, headers };

    let body;
    let statusCode = '200';

    try {
        // --- 1. AUTH EXTRACTION ---
        const claims = event.requestContext?.authorizer?.claims || event.requestContext?.authorizer?.jwt?.claims;
        const cognitoSub = claims?.sub;

        // Helper: Get internal ID
        const getUserId = async (sub) => {
            const res = await pool.query('SELECT id FROM users WHERE cognito_id = $1', [sub]);
            return res.rows[0]?.id;
        };

        // Helper: Permission Check
        const checkAccess = async (requesterId, targetUserId) => {
            if (requesterId === targetUserId) return true;
            const res = await pool.query('SELECT 1 FROM user_relationships WHERE caregiver_id = $1 AND dependent_id = $2 AND status = $3', [requesterId, targetUserId, 'active']);
            return res.rows.length > 0;
        };

        // --- 2. THE ROUTE CHAIN ---
        if (path === "/reset-db") {
            await pool.query(SCHEMA_SQL);
            body = { message: "Reset complete." };
        } 
        else if (path === "/seed-data") {
            await pool.query(SEED_SQL);
            body = { message: "Seeded." };
        }

        else if (path.startsWith("/debug/")) {
            // 2. Extract table name from path (e.g., "/debug/users" -> "users")
            const tableName = path.split("/")[2]; 

            // 3. Whitelist: Only allow these specific tables to be queried
            const allowedTables = [
                'users', 
                'appointments', 
                'medication_reminders', 
                'medication_library', 
                'test_results', 
                'test_config',
                'user_relationships',
                'genders',
                'conditions',
                'appointment_statuses'
            ];

            if (!allowedTables.includes(tableName)) {
                statusCode = '400';
                body = { error: `Table '${tableName}' is restricted or does not exist.` };
            } else {
                // 4. Execution: Since the table name is verified against the whitelist, 
                // it is now safe to use string interpolation.
                const res = await pool.query(`SELECT * FROM ${tableName} LIMIT 100`);
                body = {
                    table: tableName,
                    count: res.rowCount,
                    rows: res.rows
                };
            }
        }

        else if (path === "/genders") { body = (await pool.query('SELECT * FROM genders ORDER BY id ASC')).rows; }
        else if (path === "/conditions") { body = (await pool.query('SELECT * FROM conditions ORDER BY id ASC')).rows; }
        else if (path === "/appointment-statuses") { body = (await pool.query('SELECT * FROM appointment_statuses ORDER BY id ASC')).rows; }
        else if (path === "/medication-library") { body = (await pool.query('SELECT * FROM medication_library ORDER BY name ASC')).rows; }
        else if (path === "/test-config") { body = (await pool.query('SELECT * FROM test_config ORDER BY field_number ASC')).rows; }

        else if (path === "/check-availability" && method === "GET") {
            const email = queryParams.email ? queryParams.email.toLowerCase().trim() : null;
            const phone = queryParams.phone_number ? queryParams.phone_number.trim() : null;
        
            if (!email && !phone) {
                statusCode = '400';
                body = { error: "Email or phone number must be provided." };
            } else {
                // Query to check if either field is already taken
                const res = await pool.query(
                    'SELECT email, phone_number FROM users WHERE email = $1 OR phone_number = $2 LIMIT 1',
                    [email, phone]
                );
        
                if (res.rows.length > 0) {
                    const match = res.rows[0];
                    let field = "account details";
                    
                    // Determine specifically which field caused the conflict
                    if (match.email === email) {
                        field = "email address";
                    } else if (match.phone_number === phone) {
                        field = "phone number";
                    }
        
                    body = { exists: true, field: field };
                } else {
                    body = { exists: false };
                }
            }
        }
        
        else if (path === "/register-profile") {
            // In REST API, it's often claims.sub. 
            // In some configurations, it might be claims['cognito:username']
            const cognitoSub = event.requestContext.authorizer.claims.sub;
            
            const { username, full_name, birth_date, gender_id, condition_id, phone_number, role } = payload;
        
            const q = `
                INSERT INTO users (cognito_id, username, email, phone_number, role, full_name, birth_date, gender_id, condition_id) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
                ON CONFLICT (cognito_id) DO UPDATE SET full_name = EXCLUDED.full_name
                RETURNING *`;
            
            // Use the email directly from the verified token for extra security
            const email = event.requestContext.authorizer.claims.email;
        
            body = (await pool.query(q, [
                cognitoSub, username, email, phone_number, role, full_name, birth_date, gender_id, condition_id
            ])).rows[0];
        }

        // --- PROTECTED DATA ---
        else if (!cognitoSub) {
            statusCode = '401'; body = { error: `Cognito: login required (${path})` };
        }

        else if (path === "/my-id") body = await getUserId(cognitoSub);
        
        else if (path === "/me") {
            const q = `SELECT u.*, g.name as gender_name, c.name as condition_name FROM users u 
                       LEFT JOIN genders g ON u.gender_id = g.id LEFT JOIN conditions c ON u.condition_id = c.id WHERE u.cognito_id = $1`;
            const res = await pool.query(q, [cognitoSub]);
            if (res.rows.count == 0) { statusCode = '401'; body = { error: "User not found" }; }
            else body = res.rows[0]; statusCode = '200'
        }
        else if (path === "/my-dependents") {
            const userId = await getUserId(cognitoSub);
            const q = `
                SELECT u.id, u.username, u.full_name, r.relationship_type 
                FROM user_relationships r
                JOIN users u ON r.dependent_id = u.id
                WHERE r.caregiver_id = $1 AND r.status = 'active'`;
            body = (await pool.query(q, [userId])).rows;
        }
        else if (path === "/relationships/request") {
            const userId = await getUserId(cognitoSub);
            const target = await pool.query('SELECT id FROM users WHERE email = $1 OR username = $1', [payload.dependent_email]);
            if (target.rows.length === 0) throw new Error("Agent not found");
            const code = "TISH-" + Math.floor(100 + Math.random() * 899);
            await pool.query('INSERT INTO user_relationships (caregiver_id, dependent_id, relationship_type, verification_code) VALUES ($1,$2,$3,$4)', [userId, target.rows[0].id, payload.relationship_type, code]);
            body = { handshakeCode: code };
        }

        else if (path === "/relationships/pending") {
            const userId = await getUserId(cognitoSub);
            body = (await pool.query('SELECT r.id, u.full_name, u.username FROM user_relationships r JOIN users u ON r.caregiver_id = u.id WHERE r.dependent_id = $1 AND r.status = $2', [userId, 'pending'])).rows;
        }

        else if (path === "/relationships/respond") {
            const { request_id, action, provided_code } = payload;
            if (action === 'active') {
                const check = await pool.query('SELECT verification_code FROM user_relationships WHERE id = $1', [request_id]);
                if (check.rows[0]?.verification_code !== provided_code) throw new Error("Security Mismatch");
                await pool.query('UPDATE user_relationships SET status = $1 WHERE id = $2', ['active', request_id]);
                body = { message: "Granted" };
            } else { await pool.query('DELETE FROM user_relationships WHERE id = $1', [request_id]); body = { message: "Denied" }; }
        }

        else if (path === "/my-dependents") {
            const userId = await getUserId(cognitoSub);
            body = (await pool.query('SELECT u.id, u.username, u.full_name FROM user_relationships r JOIN users u ON r.dependent_id = u.id WHERE r.caregiver_id = $1 AND r.status = $2', [userId, 'active'])).rows;
        }

        else if (path === "/appointments") {
            const userId = await getUserId(cognitoSub);
            const targetId = queryParams.user_id ? parseInt(queryParams.user_id) : userId;

            console.log("appointments: userId: " + userId + "/ TargetID: " + targetId);

            if (!(await checkAccess(userId, targetId))) throw new Error("Access Denied");

            if (method === 'GET') {
                body = (await pool.query('SELECT a.*, s.label as status_label, s.color as status_color FROM appointments a JOIN appointment_statuses s ON a.status_id = s.id WHERE a.user_id = $1 ORDER BY a.appointment_date ASC', [targetId])).rows;
            } else if (method === 'POST') {
                const q = `INSERT INTO appointments (user_id, appointment_date, doctor_name, title, hospital, department, room_number, appointment_number, details, status_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`;
                body = (await pool.query(q, [targetId, payload.appointment_date, payload.doctor_name, payload.title, payload.hospital, payload.department, payload.room_number, payload.appointment_number, payload.details, payload.status_id])).rows[0];
            } else if (method === 'PUT') {
                const q = `UPDATE appointments SET status_id=COALESCE($1,status_id), doctor_name=COALESCE($2,doctor_name), appointment_date=COALESCE($3,appointment_date), title=COALESCE($4,title), hospital=COALESCE($5,hospital), department=COALESCE($6,department), room_number=COALESCE($7,room_number), appointment_number=COALESCE($8,appointment_number), details=COALESCE($9,details) WHERE id=$10 AND user_id=$11 RETURNING *`;
                body = (await pool.query(q, [payload.status_id, payload.doctor_name, payload.appointment_date, payload.title, payload.hospital, payload.department, payload.room_number, payload.appointment_number, payload.details, payload.id, targetId])).rows[0];
            }
        }

        else if (path === "/medication-reminders") {
            const userId = await getUserId(cognitoSub);
            const targetId = queryParams.user_id ? parseInt(queryParams.user_id) : userId;
            console.log("medication-reminders: userId: " + userId + "/ TargetID: " + targetId);
            if (!(await checkAccess(userId, targetId))) throw new Error("Access Denied");

            if (method === 'GET') {
                body = (await pool.query('SELECT r.*, l.name as med_name FROM medication_reminders r JOIN medication_library l ON r.med_id = l.id WHERE r.user_id = $1 ORDER BY r.status ASC', [targetId])).rows;
            } else if (method === 'POST' || method === 'PUT') {
                if (method === 'PUT') {
                    const q = `UPDATE medication_reminders SET
                        status = COALESCE($1, status),
                        selected_dosage = COALESCE($2, selected_dosage),
                        at_breakfast = COALESCE($3, at_breakfast),
                        breakfast_timing = COALESCE($4, breakfast_timing),
                        at_lunch = COALESCE($5, at_lunch),
                        lunch_timing = COALESCE($6, lunch_timing),
                        at_dinner = COALESCE($7, at_dinner),
                        dinner_timing = COALESCE($8, dinner_timing),
                        at_bedtime = COALESCE($9, at_bedtime),
                        frequency_days = COALESCE($10, frequency_days),
                        alarms = COALESCE($11, alarms),
                        alarm_labels = COALESCE($12, alarm_labels),
                        reminder_sound = COALESCE($13, reminder_sound)
                        WHERE id = $14 AND user_id = $15 RETURNING *`;
                    body = (await pool.query(q, [payload.status, payload.selected_dosage, payload.at_breakfast, payload.breakfast_timing, payload.at_lunch, payload.lunch_timing, payload.at_dinner, payload.dinner_timing, payload.at_bedtime, payload.frequency_days, payload.alarms, payload.alarm_labels, payload.reminder_sound, payload.id, targetId])).rows[0];
                } else {
                    const q = `INSERT INTO medication_reminders (user_id, med_id, selected_dosage, at_breakfast, breakfast_timing, at_lunch, lunch_timing, at_dinner, dinner_timing, at_bedtime, frequency_days, alarms, alarm_labels, reminder_sound) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`;
                    body = (await pool.query(q, [targetId, payload.med_id, payload.selected_dosage, payload.at_breakfast, payload.breakfast_timing, payload.at_lunch, payload.lunch_timing, payload.at_dinner, payload.dinner_timing, payload.at_bedtime, payload.frequency_days, payload.alarms, payload.alarm_labels, payload.reminder_sound])).rows[0];
                }
            } else if (method === 'DELETE') {
                await pool.query('DELETE FROM medication_reminders WHERE id = $1 AND user_id = $2', [payload.id, targetId]);
                body = { message: "Deleted" };
            }
        }

        else if (path === "/test-results") {
            const userId = await getUserId(cognitoSub);
            const targetId = queryParams.user_id ? parseInt(queryParams.user_id) : userId;
            if (!(await checkAccess(userId, targetId))) throw new Error("Access Denied");

            if (method === 'GET') {
                body = (await pool.query('SELECT * FROM test_results WHERE user_id = $1 ORDER BY test_date DESC', [targetId])).rows;
            } else if (method === 'POST' || method === 'PUT') {
                const isPut = method === 'PUT';
                const cols = []; const vals = isPut ? [payload.id] : []; 
                const addCol = (n, v) => { cols.push(isPut ? `${n} = $${vals.length + 1}` : n); vals.push(v); };
                if (!isPut) addCol('user_id', targetId);
                if (payload.test_date) addCol('test_date', payload.test_date);
                for (let i = 1; i <= 30; i++) { if (payload[`field_${i}`] !== undefined) addCol(`field_${i}`, payload[`field_${i}`] === "" ? null : payload[`field_${i}`]); }
                const query = isPut ? `UPDATE test_results SET ${cols.join(', ')} WHERE id = $1 AND user_id = ${targetId} RETURNING *` : `INSERT INTO test_results (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`;
                body = (await pool.query(query, vals)).rows[0];
            } else if (method === 'DELETE') {
                await pool.query('DELETE FROM test_results WHERE id = $1 AND user_id = $2', [payload.id, targetId]);
                body = { message: "Deleted" };
            }
        }
        else if (path === "/announcements") body = (await pool.query('SELECT * FROM announcements ORDER BY id DESC')).rows;
        else if (path === "/admin/stats") {
            const u = await pool.query('SELECT COUNT(*) FROM users');
            const a = await pool.query('SELECT COUNT(*) FROM appointments');
            body = { totalUsers: u.rows[0].count, totalMissions: a.rows[0].count };
        }
        else { statusCode = '404'; body = { error: `Not found: ${path}. Full path: ${fullPath}` }; }

    } catch (err) {
        console.error(err);
        statusCode = err.message === "Access Denied" ? '403' : '500';
        body = { error: err.message };
    }

    return { statusCode, body: JSON.stringify(body), headers };
};