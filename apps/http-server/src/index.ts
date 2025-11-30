import express from "express"
import cookieParser from "cookie-parser"
import { mainRouter } from "./router/mainRouter"
import { errorHandler } from "./middleware/errorHandler"
import checkAuth from "./middleware/auth";
import { deviceContextMiddleware } from "./middleware/deviceContext.middleware";
import cors from "cors"
import dotenv from "dotenv";
dotenv.config({ path: "../../.env" }); // load root env

const PORT = Number(process.env.HTTP_PORT) || 8080;
const app = express();


app.use(express.json())
app.use(cookieParser())
app.use(cors({
    origin:"*"
}))

app.use((req, res, next) => {
    const cookieHeader = req.headers.cookie;
    req.cookies = {};
    if (cookieHeader) {
        req.cookies = cookieHeader.split(';').reduce((acc, cookie) => {
            const [key, value] = cookie.trim().split('=');
            if (key) {
                acc[key] = decodeURIComponent(value ?? "");
            }
            return acc;
        }, {} as Record<string, string>);
    }
    next();
});


app.use(deviceContextMiddleware);

app.use(checkAuth);

app.use('/api/v1', mainRouter)


app.use(errorHandler)

app.listen(PORT,()=>{
    console.log('listening on port', PORT)
})
