import { Client, getStateCallbacks, Room, RoomAvailable } from "colyseus.js"
import firebase from "firebase/compat/app"
import { t } from "i18next"
import { NavigateFunction } from "react-router-dom"
import {
  TournamentBracketSchema,
  TournamentPlayerSchema,
  TournamentSchema
} from "../../../models/colyseus-models/tournament"
import PreparationState from "../../../rooms/states/preparation-state"
import { ICustomLobbyState, ISuggestionUser, Transfer } from "../../../types"
import type { Booster } from "../../../types/Booster"
import { CloseCodes, CloseCodesMessages } from "../../../types/enum/CloseCodes"
import { ConnectionStatus } from "../../../types/enum/ConnectionStatus"
import type { NonFunctionPropNames } from "../../../types/HelperTypes"
import { IUserMetadataClient, IUserMetadataJSON } from "../../../types/interfaces/UserMetadata"
import { logger } from "../../../utils/logger"
import { authenticateUser } from "../network"
import { LocalStoreKeys, localStore } from "../pages/utils/store"
import store, { AppDispatch } from "../stores"
import {
  addRoom,
  addTournament,
  addTournamentBracket,
  changeTournament,
  changeTournamentBracket,
  changeTournamentPlayer,
  pushMessage,
  removeRoom,
  removeTournament,
  removeTournamentBracket,
  resetLobby,
  setBoosterContent,
  setCcu,
  setSearchedUser,
  setSuggestions,
  updateTournament
} from "../stores/LobbyStore"
import {
  joinLobby,
  removeMessage,
  setConnectionStatus,
  setErrorAlertMessage,
  setPendingGameId,
  setProfile
} from "../stores/NetworkStore"
import { resetPreparation } from "../stores/PreparationStore"

export async function joinLobbyRoom(
  dispatch: AppDispatch,
  navigate: NavigateFunction
): Promise<Room<ICustomLobbyState>> {
  const promise: Promise<Room<ICustomLobbyState>> = new Promise(
    (resolve, reject) => {
      const client = store.getState().network.client
      const lobby = store.getState().network.lobby
      if (lobby?.connection.isOpen) {
        // already connected to a lobby room fully initialized
        return resolve(lobby)
      }

      authenticateUser().then(async (user) => {
        try {
          let room: Room<ICustomLobbyState> | undefined = undefined

          const reconnectToken: string = localStore.get(
            LocalStoreKeys.RECONNECTION_LOBBY
          )?.reconnectionToken
          if (reconnectToken) {
            try {
              // if a reconnect token is found, try to reconnect to the lobby room
              room = await client.reconnect(reconnectToken)
            } catch (error) {
              localStore.delete(LocalStoreKeys.RECONNECTION_LOBBY)
            }
          }

          if (!room) {
            // otherwise, connect to the lobby room
            const idToken = await user.getIdToken()
            room = await client.join("lobby", { idToken })
          }

          // store reconnection token for 5 minutes ; server may kick the inactive users before that
          dispatch(setConnectionStatus(ConnectionStatus.CONNECTED))
          localStore.set(
            LocalStoreKeys.RECONNECTION_LOBBY,
            { reconnectionToken: room.reconnectionToken, roomId: room.roomId },
            60 * 5
          )

          // setup event listeners for the lobby room
          const $ = getStateCallbacks(room)
          const $state = $(room.state)

          room.onLeave((code: number) => {
            logger.info(`left lobby with code ${code}`)
            const shouldGoToLoginPage =
              window.location.pathname === "/lobby" &&
              (code === CloseCodes.USER_INACTIVE ||
                code === CloseCodes.USER_BANNED ||
                code === CloseCodes.USER_DELETED ||
                code === CloseCodes.USER_NOT_AUTHENTICATED)
            if (shouldGoToLoginPage) {
              const errorMessage = CloseCodesMessages[code]
              if (errorMessage) {
                dispatch(setErrorAlertMessage(t(`errors.${errorMessage}`)))
              }
              navigate("/")
            }
          })

          $state.messages.onAdd((m) => {
            dispatch(pushMessage(m))
          })
          $state.messages.onRemove((m) => {
            dispatch(removeMessage(m))
          })

          $state.listen("ccu", (value) => {
            dispatch(setCcu(value))
          })

          $state.tournaments.onAdd((tournament) => {
            dispatch(addTournament(tournament))
            const $tournament = $(tournament)
            const fields: NonFunctionPropNames<TournamentSchema>[] = [
              "id",
              "name",
              "startDate"
            ]

            fields.forEach((field) => {
              $tournament.listen(field, (value) => {
                dispatch(
                  changeTournament({
                    tournamentId: tournament.id,
                    field: field,
                    value: value
                  })
                )
              })
            })

            $tournament.players.onAdd((player, userId) => {
              dispatch(updateTournament()) // TOFIX: force redux reactivity
              const $player = $(player)
              const fields: NonFunctionPropNames<TournamentPlayerSchema>[] = [
                "eliminated"
              ]
              fields.forEach((field) => {
                $player.listen(field, (value) => {
                  dispatch(
                    changeTournamentPlayer({
                      tournamentId: tournament.id,
                      playerId: userId,
                      field: field,
                      value: value
                    })
                  )
                })
              })
            })

            $tournament.players.onRemove((player, userId) => {
              dispatch(updateTournament()) // TOFIX: force redux reactivity
            })

            $tournament.brackets.onAdd((bracket, bracketId) => {
              dispatch(
                addTournamentBracket({
                  tournamendId: tournament.id,
                  bracketId,
                  bracket
                })
              )

              const $bracket = $(bracket)
              const fields: NonFunctionPropNames<TournamentBracketSchema>[] = [
                "name",
                "finished"
              ]
              fields.forEach((field) => {
                $bracket.listen(field, (value) => {
                  dispatch(
                    changeTournamentBracket({
                      tournamentId: tournament.id,
                      bracketId,
                      field,
                      value
                    })
                  )
                })
              })

              $bracket.playersId.onChange(() => {
                dispatch(
                  changeTournamentBracket({
                    tournamentId: tournament.id,
                    bracketId,
                    field: "playersId",
                    value: bracket.playersId
                  })
                )
              })
            })

            $tournament.brackets.onRemove((bracket, bracketId) => {
              dispatch(
                removeTournamentBracket({
                  tournamendId: tournament.id,
                  bracketId
                })
              )
            })
          })

          $state.tournaments.onRemove((tournament) => {
            dispatch(removeTournament(tournament))
          })

          room.onMessage(Transfer.BANNED, (message) => {
            alert(message)
          })

          room.onMessage(Transfer.ROOMS, (rooms: RoomAvailable[]) => {
            rooms.forEach((room) => dispatch(addRoom(room)))
          })

          room.onMessage(Transfer.REQUEST_ROOM, async (roomId: string) => {
            joinExistingPreparationRoom(
              roomId,
              client,
              lobby,
              dispatch,
              navigate
            )
          })

          room.onMessage(Transfer.ADD_ROOM, ([, room]) => {
            if (room.name === "preparation" || room.name === "game") {
              dispatch(addRoom(room))
            }
          })

          room.onMessage(Transfer.REMOVE_ROOM, (roomId: string) =>
            dispatch(removeRoom(roomId))
          )

          room.onMessage(Transfer.USER_PROFILE, (user: IUserMetadataJSON) => {
            dispatch(setProfile(user))
          })

          room.onMessage(Transfer.RECONNECT_PROMPT, (pendingGameId: string) => {
            dispatch(setPendingGameId(pendingGameId))
          })

          room.onMessage(Transfer.USER, (user: IUserMetadataClient) =>
            dispatch(setSearchedUser(user))
          )

          room.onMessage(
            Transfer.BOOSTER_CONTENT,
            (boosterContent: Booster) => {
              dispatch(setBoosterContent(boosterContent))
            }
          )

          room.onMessage(
            Transfer.SUGGESTIONS,
            (suggestions: ISuggestionUser[]) => {
              dispatch(setSuggestions(suggestions))
            }
          )

          dispatch(joinLobby(room)) // lobby room is now fully initialized and accessible from state.network.lobby

          resolve(room)
        } catch (error) {
          reject(error)
        }
      })
    }
  )

  promise.catch((err) => {
    logger.error(err)
    if (err.message) {
      dispatch(setErrorAlertMessage(err.message))
    }
    navigate("/")
  })

  return promise
}

export async function joinExistingPreparationRoom(
  roomId: string,
  client: Client,
  lobby: Room<ICustomLobbyState> | undefined,
  dispatch: AppDispatch,
  navigate: NavigateFunction
) {
  try {
    const token = await firebase.auth().currentUser?.getIdToken()
    if (token) {
      dispatch(resetPreparation())
      const room: Room<PreparationState> = await client.joinById(roomId, {
        idToken: token
      })
      if (room.name !== "preparation") {
        room.connection.isOpen && room.leave(false)
        throw new Error(
          `Expected to join a preparation room but joined ${room.name} instead`
        )
      }
      localStore.set(
        LocalStoreKeys.RECONNECTION_PREPARATION,
        {
          reconnectionToken: room.reconnectionToken,
          roomId: room.roomId
        },
        30
      )
      await Promise.allSettled([
        lobby?.connection.isOpen && lobby.leave(false),
        room.connection.isOpen && room.leave(false)
      ])
      dispatch(resetLobby())
      navigate("/preparation")
    }
  } catch (error) {
    if (error.code && error.code in CloseCodesMessages) {
      const errorMessage = CloseCodesMessages[error.code]
      dispatch(setErrorAlertMessage(t(`errors.${errorMessage}`)))
    } else {
      logger.error(error)
    }
  }
}
