import { Request, Response, NextFunction } from "express";
import { postService } from "../services/post.service.js";
import { sendSuccess, buildPaginationMeta } from "../utils/response.js";
import { AuthRequest, parsePagination } from "../types/index.js";

export const postController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const post = await postService.createPost(userId, req.body);
      sendSuccess(res, post, "Post created", 201);
    } catch (err) {
      next(err);
    }
  },

  async getFeed(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const { page, limit } = parsePagination(req.query);
      const { posts, total } = await postService.getFeed(userId, page, limit);
      sendSuccess(
        res,
        posts,
        "Feed",
        200,
        buildPaginationMeta(total, page, limit),
      );
    } catch (err) {
      next(err);
    }
  },

  async getOne(req: Request, res: Response, next: NextFunction) {
    try {
      const postId =
        typeof req.params.id === "string" ? req.params.id : req.params.id[0];
      const post = await postService.getPost(postId);
      sendSuccess(res, post);
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const postId =
        typeof req.params.id === "string" ? req.params.id : req.params.id[0];
      const post = await postService.updatePost(
        postId,
        userId,
        req.body,
      );
      sendSuccess(res, post, "Post updated");
    } catch (err) {
      next(err);
    }
  },

  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const postId =
        typeof req.params.id === "string" ? req.params.id : req.params.id[0];
      const result = await postService.deletePost(postId, userId);
      sendSuccess(res, result, result.message);
    } catch (err) {
      next(err);
    }
  },

  async like(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const postId =
        typeof req.params.id === "string" ? req.params.id : req.params.id[0];
      const result = await postService.likePost(postId, userId);
      sendSuccess(res, result, result.message, 201);
    } catch (err) {
      next(err);
    }
  },

  async unlike(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const postId =
        typeof req.params.id === "string" ? req.params.id : req.params.id[0];
      const result = await postService.unlikePost(postId, userId);
      sendSuccess(res, result, result.message);
    } catch (err) {
      next(err);
    }
  },

  async comment(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const postId =
        typeof req.params.id === "string" ? req.params.id : req.params.id[0];
      const { content, repliedToId } = req.body;
      const comment = await postService.addComment(
        postId,
        userId,
        content,
        repliedToId,
      );
      sendSuccess(res, comment, "Comment added", 201);
    } catch (err) {
      next(err);
    }
  },

  async save(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const postId =
        typeof req.params.id === "string" ? req.params.id : req.params.id[0];
      const result = await postService.savePost(postId, userId);
      sendSuccess(res, result, result.message, 201);
    } catch (err) {
      next(err);
    }
  },

  async unsave(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const postId =
        typeof req.params.id === "string" ? req.params.id : req.params.id[0];
      const result = await postService.unsavePost(postId, userId);
      sendSuccess(res, result, result.message);
    } catch (err) {
      next(err);
    }
  },

  async getSaved(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const { page, limit } = parsePagination(req.query);
      const { posts, total } = await postService.getSavedPosts(userId, page, limit);
      sendSuccess(res, posts, "Saved posts", 200, buildPaginationMeta(total, page, limit));
    } catch (err) {
      next(err);
    }
  },

  async getStories(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const stories = await postService.getStories(userId);
      sendSuccess(res, stories, "Stories");
    } catch (err) {
      next(err);
    }
  },

  async createStory(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const story = await postService.createStory(userId, req.body);
      sendSuccess(res, story, "Story created", 201);
    } catch (err) {
      next(err);
    }
  },

  async viewStory(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const { storyId } = req.params;
      await postService.markStoryViewed(userId, storyId as string);
      sendSuccess(res, { viewed: true });
    } catch (err) {
      next(err);
    }
  },
};
