// server.js (최종 버전: 모든 기능, 경로 설정, 포트 설정 포함)

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require("socket.io"); 
const { shuffle } = require('lodash');
const fs = require('fs');

// [경로 변수]
const dataPath = path.join(__dirname, 'data');
const itemsFilePath = path.join(dataPath, 'auctionItems.json');
const teamsFilePath = path.join(dataPath, 'teamState.json'); 
const stateFilePath = path.join(dataPath, 'auctionState.json');

// ********** 경매 상태 및 사용자/팀 관리 변수 **********
let auctionState = {
    isStarted: false,      
    isRaffleRound: false, 
    currentItemIndex: -1,  
    currentHighestBid: 0,  
    highestBidderId: null, 
    highestBidderNickname: null 
};

const userMap = {}; 
let captainMap = {}; 
let auctionItems = []; 
let teams = [];
let failedItems = []; // 유찰 선수 목록 변수 초기화

// ********** 타이머 관련 변수 **********
let countdownTimer = null;
const COUNTDOWN_TIME = 10; 
let currentCountdown = COUNTDOWN_TIME;
// **********************************************

// 데이터 로드/저장 함수
function loadData() {
    try {
        if (fs.existsSync(itemsFilePath)) {
            auctionItems = JSON.parse(fs.readFileSync(itemsFilePath, 'utf8'));
            failedItems = auctionItems.filter(item => item.winner === '유찰');
        }
        if (fs.existsSync(teamsFilePath)) {
            teams = JSON.parse(fs.readFileSync(teamsFilePath, 'utf8'));
        }
        if (fs.existsSync(stateFilePath)) {
            const loadedState = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
            auctionState = { ...auctionState, ...loadedState };
        }
    } catch (error) {
        console.error('데이터 로드 중 오류 발생:', error);
    }
}

function saveData() {
    try {
        if (!fs.existsSync(dataPath)) {
            fs.mkdirSync(dataPath);
        }
        fs.writeFileSync(itemsFilePath, JSON.stringify(auctionItems, null, 2), 'utf8');
        fs.writeFileSync(teamsFilePath, JSON.stringify(teams, null, 2), 'utf8');
        fs.writeFileSync(stateFilePath, JSON.stringify(auctionState, null, 2), 'utf8');
    } catch (error) {
        console.error('데이터 저장 중 오류 발생:', error);
    }
}

// 초기 데이터 로드
loadData();


const app = express();
// [핵심 수정: public 폴더 경로 설정]
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const server = http.createServer(app); 
const io = new Server(server);


// *********************************************************
// [경매 초기화 기능] 
// *********************************************************
function resetAuction() {
    // 1. 핵심 상태 변수를 초기값으로 리셋
    auctionState = {
        isStarted: false,
        isRaffleRound: false,
        currentItemIndex: -1,
        currentHighestBid: 0,
        highestBidderId: null,
        highestBidderNickname: null
    };
    
    // 2. 타이머 중지
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    currentCountdown = COUNTDOWN_TIME;

    // 3. 경매 물품과 팀의 낙찰/예산 정보를 초기 상태로 리셋
    auctionItems.forEach(item => { 
        item.isAuctioned = false; 
        item.winner = null; 
        item.finalBid = 0;
    });
    failedItems = []; // 유찰자 목록도 초기화

    teams.forEach(team => {
        team.budget = team.initialBudget || 10000; 
        team.players = [];
    });

    // 4. 저장소에 초기화된 데이터 반영
    saveData(); 
    
    console.log('관리자 요청으로 경매 상태가 전체 초기화되었습니다.');
}
// *********************************************************


// ********** Helper: 사용자 목록 전파 함수 **********
function broadcastUserList() {
    io.emit('userListUpdate', { users: Object.values(userMap), captainMap: captainMap });
}

// ********** Helper: 경매 상태 전파 함수 **********
function broadcastBidUpdate() {
    const currentItemList = auctionState.isRaffleRound ? failedItems : auctionItems;

    const currentItem = auctionState.currentItemIndex >= 0 
        ? currentItemList[auctionState.currentItemIndex]
        : null;

    io.emit('updateBid', {
        isStarted: auctionState.isStarted,
        currentItemIndex: auctionState.currentItemIndex,
        currentItem: currentItem,
        amount: auctionState.currentHighestBid,
        bidderNickname: auctionState.highestBidderNickname,
        isRaffleRound: auctionState.isRaffleRound,
    });
}

// ********** Helper: 경매 종료 처리 함수 **********
function processAuctionEnd() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    if (!auctionState.isStarted) return;
    auctionState.isStarted = false;
    
    const currentItemList = auctionState.isRaffleRound ? failedItems : auctionItems;

    const item = currentItemList[auctionState.currentItemIndex];
    let winnerTeam = null;
    let finalBid = 0;
    let winnerNickname = null;
    let isSold = false; 

    if (auctionState.highestBidderId) {
        winnerNickname = auctionState.highestBidderNickname;
        winnerTeam = captainMap[winnerNickname];
        finalBid = auctionState.currentHighestBid;
        
        const winningTeam = teams.find(t => t.name === winnerTeam);
        
        if (winningTeam && winningTeam.budget >= finalBid && winningTeam.players.length < 4) {
            winningTeam.budget -= finalBid;
            winningTeam.players.push({ nickname: item.nickname, pos: item.mainPos });
            item.winner = winnerTeam;
            item.finalBid = finalBid;
            item.isAuctioned = true; 
            isSold = true;
        } else {
             winnerTeam = '유찰';
             winnerNickname = '유찰';
             finalBid = 0;
             item.winner = '유찰';
             item.finalBid = 0;
        }
    } else {
        winnerTeam = '유찰';
        winnerNickname = '유찰';
        finalBid = 0;
        item.winner = '유찰';
        item.finalBid = 0;
    }

    // 유찰 시 failedItems에 추가 (1차 경매에서만)
    if (item.winner === '유찰' && !auctionState.isRaffleRound) {
        if (!failedItems.find(i => i.id === item.id)) {
             failedItems.push(item);
        }
    }
    
    // 2차 경매에서 낙찰되면 failedItems에서 제거
    if (auctionState.isRaffleRound && isSold) {
        const index = failedItems.findIndex(i => i.id === item.id);
        if (index > -1) {
            failedItems.splice(index, 1);
        }
    }
    
    io.emit('auctionResult', {
        itemNickname: item.nickname,
        winnerTeam: winnerTeam,
        finalBid: finalBid,
        winnerNickname: winnerNickname
    });

    auctionState.currentHighestBid = 0;
    auctionState.highestBidderId = null;
    auctionState.highestBidderNickname = null;
    currentCountdown = COUNTDOWN_TIME; 

    // 경매 종료 후 다음 항목으로 넘어가는 로직
    const nextItemIndex = auctionState.currentItemIndex + 1;
    const currentListTotal = currentItemList.length;

    if (nextItemIndex < currentListTotal) {
        auctionState.currentItemIndex = nextItemIndex;
    } else {
        auctionState.currentItemIndex = -1; // 경매 목록 끝
        auctionState.isRaffleRound = false; // 2차 경매 종료
    }
    
    saveData();
    io.emit('teamUpdate', teams);
    io.emit('itemUpdate', auctionItems);
    broadcastBidUpdate();
}

// ********** Helper: 타이머 시작 함수 **********
function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    currentCountdown = COUNTDOWN_TIME;
    
    const currentItemList = auctionState.isRaffleRound ? failedItems : auctionItems;

    const currentItem = currentItemList[auctionState.currentItemIndex];
    
    io.emit('updateBid', { 
        amount: auctionState.currentHighestBid,
        bidderNickname: auctionState.highestBidderNickname,
        currentItem: currentItem, 
        isStarted: true 
    });
    io.emit('updateCountdown', currentCountdown); 

    countdownTimer = setInterval(() => {
        currentCountdown--;
        io.emit('updateCountdown', currentCountdown); 
        
        if (currentCountdown <= 0) {
            processAuctionEnd();
        }
    }, 1000);
}


// 라우팅 
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'bidder.html'));
});

app.get('/host', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

// Host 화면에서 필요한 상태 정보 전송 (GET API는 그대로 유지)
app.get('/api/items', (req, res) => res.json(auctionItems));
app.post('/api/item', (req, res) => {
    const newItem = req.body;
    newItem.id = Date.now(); 
    newItem.isAuctioned = false; 
    newItem.winner = null; 
    newItem.finalBid = 0;
    auctionItems.push(newItem);
    io.emit('itemUpdate', auctionItems); 
    res.status(201).json(newItem);
});
app.delete('/api/items', (req, res) => {
    auctionItems = [];
    failedItems = []; // 유찰자 명단 초기화 추가
    io.emit('itemUpdate', auctionItems);
    res.status(200).send('모든 선수 목록이 삭제되었습니다.');
});
app.get('/api/teams', (req, res) => res.json(teams));
app.delete('/api/teams', (req, res) => {
    teams = [];
    captainMap = {}; 
    io.emit('teamUpdate', teams);
    io.emit('captainMapUpdate', captainMap); 
    res.status(200).send('모든 팀 목록이 삭제되었습니다.');
});
// ******************************************************

// ****************************
// Socket.io 접속 이벤트 처리
io.on('connection', (socket) => {
    
    // 초기 데이터 전송
    const currentItemList = auctionState.currentItemIndex >= 0 ? (auctionState.isRaffleRound ? failedItems : auctionItems) : auctionItems;

    const currentItem = auctionState.currentItemIndex >= 0 ? currentItemList[auctionState.currentItemIndex] : null;
    socket.emit('updateBid', {
        amount: auctionState.currentHighestBid,
        bidderNickname: auctionState.highestBidderNickname,
        currentItem: currentItem, 
        isStarted: auctionState.isStarted 
    });

    socket.emit('itemUpdate', auctionItems); 
    socket.emit('teamUpdate', teams); 
    socket.emit('captainMapUpdate', captainMap);
    if (auctionState.isStarted) {
        socket.emit('updateCountdown', currentCountdown);
    }

    socket.on('requestUserList', () => { broadcastUserList(); });

    socket.on('setNickname', (nickname) => {
        if (!nickname || nickname.length > 10) {
            socket.emit('message', '🚨 닉네임이 유효하지 않습니다.');
            return;
        }
        userMap[socket.id] = nickname;
        broadcastUserList(); 
    });

    // Host 명령 이벤트 처리 (기존 로직 유지)
    socket.on('addTeam', (teamData) => {
        const teamName = teamData.name;
        if (teams.find(t => t.name === teamName)) {
            socket.emit('message', `🚨 팀명 "${teamName}"은 이미 존재합니다.`);
            return;
        }
        teams.push({ name: teamName, budget: teamData.budget, players: [] });
        saveData();
        io.emit('teamUpdate', teams);
        broadcastUserList(); 
    });
    
    socket.on('assignCaptain', ({ nickname, teamName }) => {
        for (const [capName, capTeamName] of Object.entries(captainMap)) {
            if (capTeamName === teamName) {
                delete captainMap[capName];
            }
        }
        captainMap[nickname] = teamName;
        saveData();
        io.emit('captainMapUpdate', captainMap);
        broadcastUserList(); 
    });
    
    socket.on('shuffleAndPrepare', () => {
        if (auctionItems.length === 0) {
            socket.emit('message', '🚨 경매할 선수가 없습니다. 먼저 선수를 등록해 주세요.');
            return;
        }
        if (countdownTimer) clearInterval(countdownTimer);
        countdownTimer = null;
        
        auctionItems = shuffle(auctionItems);
        failedItems = []; // 유찰자 목록 초기화
        auctionState.isRaffleRound = false; // 1차 경매 모드
        
        auctionState.currentItemIndex = 0; 
        auctionState.currentHighestBid = 0;
        auctionState.highestBidderId = null;
        auctionState.highestBidderNickname = null;
        auctionState.isStarted = false;

        saveData();
        io.emit('itemUpdate', auctionItems);
        broadcastBidUpdate();
        socket.emit('message', `✅ 선수 목록을 섞고 첫 경매 준비를 완료했습니다.`);
    });
    
    // 유찰자 경매 시작
    socket.on('startRaffleRound', () => {
        if (failedItems.length === 0) return socket.emit('message', '🚨 유찰된 선수가 없습니다.');
        
        failedItems = shuffle(failedItems); 
        auctionState.isRaffleRound = true;
        auctionState.currentItemIndex = 0;
        auctionState.currentHighestBid = 0;
        auctionState.highestBidderId = null; 
        auctionState.highestBidderNickname = null;

        auctionState.isStarted = true; 
        startCountdown();

        socket.emit('message', `✅ 유찰자 경매가 시작되었습니다!`);
    });
    
    // [강제 배정 기능 - 항상 활성화]
    socket.on('assignItemToTeam', ({ teamName }) => {
        
        // 현재 경매 대상 리스트를 isRaffleRound에 따라 결정
        const currentItemList = auctionState.isRaffleRound ? failedItems : auctionItems; 
        
        // 현재 경매 대상이 없으면 리턴
        if (auctionState.currentItemIndex < 0 || auctionState.currentItemIndex >= currentItemList.length) {
            return socket.emit('message', '🚨 현재 경매할 선수가 지정되지 않았습니다. 경매를 시작하거나 유찰자 경매를 시작하세요.');
        }

        const currentItem = currentItemList[auctionState.currentItemIndex];
        const targetTeam = teams.find(t => t.name === teamName);
        
        if (!targetTeam || targetTeam.players.length >= 4) return socket.emit('message', `🚨 팀 배정 실패: 팀을 찾을 수 없거나 로스터가 가득 찼습니다.`);
        
        // 1. 팀에 선수 추가
        targetTeam.players.push({ nickname: currentItem.nickname, pos: currentItem.mainPos });
        
        // 2. 경매 물품 정보 업데이트 (모든 아이템 목록에서)
        const originalItem = auctionItems.find(i => i.id === currentItem.id);
        if (originalItem) {
            originalItem.isAuctioned = true;
            originalItem.winner = teamName;
            originalItem.finalBid = 0; 
        }

        // 3. 유찰자 목록에서 제거 (유찰자 경매 라운드일 경우에만)
        if (auctionState.isRaffleRound) {
            const index = failedItems.findIndex(i => i.id === currentItem.id);
            if (index > -1) {
                failedItems.splice(index, 1);
            }
        }

        // 4. 경매 상태 초기화
        auctionState.isStarted = false;
        
        // 5. 다음 항목으로 인덱스 이동 (현재 목록 기준으로)
        const nextItemIndex = auctionState.currentItemIndex + 1;
        
        if (nextItemIndex < currentItemList.length) {
            auctionState.currentItemIndex = nextItemIndex;
        } else {
            auctionState.currentItemIndex = -1; // 경매 목록 끝
            auctionState.isRaffleRound = false; 
        }
        
        auctionState.currentHighestBid = 0;
        auctionState.highestBidderId = null;
        auctionState.highestBidderNickname = null;
        
        saveData();
        io.emit('auctionResult', { itemNickname: currentItem.nickname, winnerTeam: teamName, finalBid: 0, winnerNickname: '강제 배정' });
        io.emit('itemUpdate', auctionItems); 
        io.emit('teamUpdate', teams); 
        
        broadcastBidUpdate();
        socket.emit('message', `✅ ${currentItem.nickname} 선수를 ${teamName}에 강제 배정했습니다. (0원)`);
    });
    
    socket.on('startNextAuction', () => {
        const currentItemList = auctionState.isRaffleRound ? failedItems : auctionItems;

        if (auctionState.currentItemIndex >= currentItemList.length) return;
        
        if (!auctionState.isRaffleRound && currentItemList[auctionState.currentItemIndex].isAuctioned) {
             auctionState.currentItemIndex++;
             broadcastBidUpdate();
             return;
        }

        auctionState.isStarted = true;
        auctionState.currentHighestBid = 0;
        auctionState.highestBidderId = null;
        auctionState.highestBidderNickname = null;
        startCountdown();
    });

    socket.on('endAuction', () => {
        if (!auctionState.isStarted) return;
        processAuctionEnd();
    });

    socket.on('placeBid', (bidAmount) => {
        if (!auctionState.isStarted || bidAmount <= auctionState.currentHighestBid) return;

        const bidderNickname = userMap[socket.id];
        const teamName = captainMap[bidderNickname];
        const team = teams.find(t => t.name === teamName);
        
        if (!teamName || team.players.length >= 4 || team.budget < bidAmount) return;
        
        auctionState.currentHighestBid = bidAmount;
        auctionState.highestBidderId = socket.id;
        auctionState.highestBidderNickname = bidderNickname;
        
        startCountdown(); 
    });

    socket.on('disconnect', () => {
        delete userMap[socket.id];
        broadcastUserList();
        if (auctionState.highestBidderId === socket.id) {
            auctionState.highestBidderId = null;
            auctionState.highestBidderNickname = '최고 입찰자가 연결을 끊었습니다.';
            broadcastBidUpdate();
        }
    });
    
    socket.on('requestUserList', () => {
        broadcastUserList();
    });

    // [경매 초기화 기능 추가] 
    socket.on('reset_auction', () => {
        resetAuction(); // 초기화 함수 호출

        io.emit('auction_state_update', auctionState); 
        io.emit('teamUpdate', teams); 
        io.emit('itemUpdate', auctionItems); 
        io.emit('system_message', '경매가 관리자에 의해 초기화되었습니다.');
    });

});
// ****************************

// 8. 서버 구동
const PORT = process.env.PORT || 3000; 
server.listen(PORT, () => {
    console.log(`✅ 서버가 ${PORT}번 포트에서 실행 중입니다.`);
});
