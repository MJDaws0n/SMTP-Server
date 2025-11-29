const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const { simpleParser } = require('mailparser');
const mysql = require('mysql2');
const tls = require('tls');
const { Buffer } = require('buffer');
const https = require('https');

const dbConfig = {
    host: '',
    port: 3306,
    user: '',
    password: '',
    database: 's66_mail'
};

// Configuration
const HOST = '0.0.0.0';
const PORT = 1043;

getPublicIp((error, OURIP) => {
    // Create the TCP server
    const server = net.createServer((socket) => {
        let firstMessage = true;
        if(OURIP == socket.remoteAddress.toString()){
            console.log('New client connected - '+socket.remoteAddress.toString() + '. Most likley using PortRedirect, attempting to get real IP');
        } else{
            console.log('New client connected - '+socket.remoteAddress.toString() + '.');
        }

        const client = {
            identifyer: crypto.randomBytes(16).toString('hex'),
            op: false,
            data: ''
        };

        // Welcome message to the new client
        socket.write('220 imap-ssl.mjdawson.net ESMTP '+client.identifyer+' - MJDawsonsSMTP\r\n');

        // Broadcast messages to all clients
        socket.on('data', (data) => {
            // Using PortsRedirec with TCP sendIP, so this is required to get the client IP
            if(firstMessage && OURIP == socket.remoteAddress.toString()){
                firstMessage = false;
                const clientData = parseJSON(data);

                if(clientData && clientData.ip){
                    // Update the IP
                    socket.clientIp = clientData.ip;
                    console.log('Found real client IP - '+clientData.ip);
                }
                // Otherwise just assume it's not using PortsRedirect
                return;
            }
            const message = data.toString().trim();
            const args = message.split(' ');
            console.log('Client Says: '+data.toString().trim());
            if(!args[0]){
                socket.write('502-5.5.1 Unrecognized command.\r\n');
            }
            handleCommand(socket, args, client, message)
        });

        // Remove the client from the clients array when they disconnect
        socket.on('end', () => {
            console.log('Client disconnected');
        });

        // Handle socket errors
        socket.on('error', (err) => {
            console.error('Socket error:', err);
        });
    });

    // Start the server
    server.listen(PORT, HOST, () => {
        console.log(`SMTP server running at ${HOST}:${PORT}`);
    });
});


function handleCommand(socket, args, client, message){
    if(client.op != 'data'){
        switch (args[0].toUpperCase()) {
            case 'EHLO':
                handleEhlo(socket);
                break;
            case 'MAIL': // MAIL FROM:
                if(args[1].startsWith('FROM:')){
                    handleEmail(socket, args, client);
                    break;
                }
            case 'RCPT': // RCPT To:
                if(args[1].startsWith('TO:')){
                    handleRCPT(socket, args, client);
                    break;
                }
            case 'DATA':
                handleDATA(socket, args, client);
                break;
            case 'QUIT':
                socket.write('221 Bye\r\n');
                socket.end();
                break;
            default:
                socket.write('502 Command not implemented\r\n');
                break;
        }
    } else{
        if(message == '.'){
            client.op = false;
            socket.write('250 OK\r\n');

            parseEmailData(client.data, (err, parsedData) => {
                if (err) {
                    socket.write('554 5.6.0 Message data rejected\r\n');
                } else {
                    socket.write('250 OK\r\n');
                    uploadEmail(parsedData);
                }
            });
        } else if(message.endsWith('\r\n.')){
            client.op = false;
            client.data += message.slice(0, -3);

            parseEmailData(client.data, (err, parsedData) => {
                if (err) {
                    socket.write('554 5.6.0 Message data rejected\r\n');
                } else {
                    socket.write('250 OK\r\n');
                    uploadEmail(parsedData);
                }
            });
        } else{
            client.data += message;
        }
    }
}

function handleEhlo(socket){
    const response = [
        `250-imap-ssl.mjdawson.net at your service, [${socket.clientIp.toString()}]`,
        '250-SIZE 35882577',
        '250-8BITMIME',
        '250 HELP'
    ].join('\r\n') + '\r\n';

    socket.write(response);
}
function handleEmail(socket, args, client) {
    // Extract the email address from the MAIL FROM command
    const emailAdr = extractEmailFromCommand1(args[1]);

    // Check if the email address is present
    if (!emailAdr) {
        socket.write('502 Unrecognized command\r\n');
        return;
    }

    // Validate the email address
    if (validateEmail(emailAdr)) {
        client.op = 'new';
        client.newMail = {
            from: emailAdr
        };
        socket.write('250 OK\r\n');
    } else {
        socket.write('550 Sender address rejected\r\n');
    }
}
function handleRCPT(socket, args, client) {
    if(client.op != 'new'){
        socket.write('502 Unrecognized command\r\n');
        return;
    }
    // Extract the email address from the MAIL FROM command
    const emailAdr = extractEmailFromCommand2(args[1]);

    // Check if the email address is present
    if (!emailAdr) {
        socket.write('502 Unrecognized command\r\n');
        return;
    }

    // Validate the email address
    if (validateEmail(emailAdr)) {
        client.newMail.to = emailAdr;
        socket.write('250 OK\r\n');
    } else {
        socket.write('550 Recipient address rejected\r\n');
    }

    console.log(client.newMail);
}
function handleDATA(socket, args, client) {
    if(client.op != 'new'){
        socket.write('502 Unrecognized command\r\n');
        return;
    }
    client.op = 'data';
    socket.write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
}



function extractEmailFromCommand1(command) {
    // Extracts the email address from the MAIL FROM command
    const match = command.match(/FROM:<(.+)>/);
    return match ? match[1] : null;
}
function extractEmailFromCommand2(command) {
    // Extracts the email address from the MAIL FROM command
    const match = command.match(/TO:<(.+)>/);
    return match ? match[1] : null;
}
function validateEmail(adr) {
    // More Validation needed later
    return adr && adr.includes('@');
}
function parseEmailData(rawEmail, callback) {
    simpleParser(rawEmail, (err, parsed) => {
        if (err) {
            callback(err, null);
            return;
        }
        console.log(parsed);
        callback(null, {
            subject: parsed.subject,
            from: parsed.from.text,
            to: parsed.to.text,
            date: parsed.date,
            messageID: parsed.messageId,
            headers: parsed.headers,
            textBody: parsed.text,
            HTMLBody: parsed.html,
        });
    });
}
async function uploadEmail(emailData) {
    console.log(emailData);
    // Create a connection to the database
    const connection = mysql.createConnection(dbConfig);

    // Promisify the query function
    const query = (sql, params) => {
        return new Promise((resolve, reject) => {
            connection.query(sql, params, (error, results) => {
                if (error) {
                    return reject(error);
                }
                resolve(results);
            });
        });
    };

    try {
        // Connect to the database
        connection.connect();

        // Prepare SQL insert statement
        const sql = `
            INSERT INTO emails (mailFrom, mailTo, subject, HTML_body)
            VALUES (?, ?, ?, ?)
        `;

        // Extract email data
        const { from, to, subject, HTMLBody } = emailData;

        // Execute the query
        const results = await query(sql, [from, to, subject, HTMLBody]);

        console.log('Email successfully uploaded. Insert ID:', results.insertId);
        refreshMail();
    } catch (error) {
        console.error('Error uploading email:', error);
    } finally {
        // End the database connection
        connection.end();
    }
}

function refreshMail(){
    const options = {
        host: 'imap-ssl.mjdawson.net',
        port: 1042,
        rejectUnauthorized: false // Set to true if the server's SSL certificate should be verified
    };

    // Create a TLS connection
    const client = tls.connect(options, () => {
        console.log('Connected to the IMAP server');

        // Send the REFRESH_MAIL command
        // Note: REFRESH_MAIL is not a standard IMAP command, so you might need to use a valid command or adjust this
        client.write('1 REFRESH_MAIL\r\n');

        // Handle server response
        client.on('data', (data) => {
            console.log('Server response:', data.toString());

            // Optionally, close the connection after receiving the response
            client.end();
        });

        // Handle connection errors
        client.on('error', (error) => {
            console.error('Connection error:', error);
        });

        // Handle connection closure
        client.on('end', () => {
            console.log('Connection ended');
        });
    });
}
function parseJSON(jsonString) {
    try {
        // Attempt to parse the JSON string
        const parsedObject = JSON.parse(jsonString);
        
        // If parsing is successful, return the parsed object
        return parsedObject;
    } catch (error) {
        // If an error occurs during parsing, return an error message
        return null;
    }
}
function getPublicIp(callback) {
  https.get('https://api.ipify.org?format=json', (resp) => {
    let data = '';

    // A chunk of data has been received.
    resp.on('data', (chunk) => {
      data += chunk;
    });

    // The whole response has been received.
    resp.on('end', () => {
      try {
        const ipData = JSON.parse(data);
        callback(null, ipData.ip);
      } catch (error) {
        callback(error);
      }
    });

  }).on("error", (err) => {
    callback(err);
  });
}
